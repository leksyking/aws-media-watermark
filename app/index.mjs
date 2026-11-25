import {
    S3Client,
    GetObjectCommand,
    HeadObjectCommand,
    PutObjectCommand,
    CopyObjectCommand,
    DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import sharp from "sharp";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

const s3 = new S3Client({});
const BUCKET = process.env.BUCKET_NAME;
const WATERMARK_KEY =
    process.env.WATERMARK_KEY || "watermark-assets/LeksyMark.png";
const TEMP_PREFIX = process.env.TEMP_PREFIX || "watermark-tmp/";

const FFMPEG = "/opt/bin/ffmpeg"; // provided by the Lambda layer

// Upload events we process. "Copy" is deliberately missing: the final
// write-back is a copy, so ignoring copies is what prevents a loop.
const HANDLED_EVENTS = new Set([
    "ObjectCreated:Put",
    "ObjectCreated:Post",
    "ObjectCreated:CompleteMultipartUpload",
]);

const MEDIA_BY_EXT = {
    ".jpg": { kind: "image", contentType: "image/jpeg" },
    ".jpeg": { kind: "image", contentType: "image/jpeg" },
    ".png": { kind: "image", contentType: "image/png" },
    ".webp": { kind: "image", contentType: "image/webp" },
    ".mp4": { kind: "video", contentType: "video/mp4" },
};

const EXT_BY_CONTENT_TYPE = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "video/mp4": ".mp4",
};

/**
 * Work out what a file is from its extension, or from its Content-Type
 * when the key has no usable extension (e.g. "uploads/3f2a9c").
 * Returns null for anything we don't handle.
 */
export function resolveMedia(key, contentType) {
    const ext = path.extname(key).toLowerCase();
    if (MEDIA_BY_EXT[ext]) return { ext, ...MEDIA_BY_EXT[ext] };

    const type = (contentType || "").split(";")[0].trim().toLowerCase();
    const fallbackExt = EXT_BY_CONTENT_TYPE[type];
    if (fallbackExt) return { ext: fallbackExt, ...MEDIA_BY_EXT[fallbackExt] };

    return null;
}

async function downloadObject(key, destination) {
    const result = await s3.send(
        new GetObjectCommand({ Bucket: BUCKET, Key: key })
    );
    await pipeline(result.Body, createWriteStream(destination));
}

function runFFmpeg(args) {
    return new Promise((resolve, reject) => {
        const child = spawn(FFMPEG, args, {
            stdio: ["ignore", "ignore", "pipe"],
        });

        let stderr = "";
        child.stderr.on("data", (chunk) => {
            stderr += chunk.toString();
            // Keep only the last 20 KB of diagnostics.
            if (stderr.length > 20000) stderr = stderr.slice(-20000);
        });

        child.on("error", reject);
        child.on("close", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`FFmpeg exited with code ${code}: ${stderr}`));
        });
    });
}

export async function watermarkImage(input, output, logo, ext) {
    // Apply EXIF orientation to the pixels so phone photos aren't sideways.
    const orientedBuffer = await sharp(input).rotate().toBuffer();
    const { width, height } = await sharp(orientedBuffer).metadata();

    if (!width || !height) {
        throw new Error("Could not determine image dimensions");
    }

    // Logo fits inside 25% of the width and 25% of the height, so it can
    // never be larger than the image (Sharp would throw if it were).
    const watermark = await sharp(logo)
        .resize({
            width: Math.max(1, Math.round(width * 0.25)),
            height: Math.max(1, Math.round(height * 0.25)),
            fit: "inside",
            withoutEnlargement: true,
        })
        .png()
        .toBuffer();

    const wm = await sharp(watermark).metadata();
    const margin = Math.max(8, Math.round(Math.min(width, height) * 0.025));
    const left = Math.max(0, width - wm.width - margin);
    const top = Math.max(0, height - wm.height - margin);

    let outputImage = sharp(orientedBuffer).composite([
        { input: watermark, left, top, blend: "over" },
    ]);

    if (ext === ".jpg" || ext === ".jpeg") {
        outputImage = outputImage.jpeg({ quality: 88 });
    } else if (ext === ".webp") {
        outputImage = outputImage.webp({ quality: 88 });
    } else {
        outputImage = outputImage.png();
    }

    await outputImage.toFile(output);
}

async function watermarkVideo(input, output, logo) {
    await runFFmpeg([
        "-hide_banner",
        "-loglevel", "error",
        "-y",
        "-i", input, // input 0: the video
        "-i", logo, // input 1: the PNG
        "-filter_complex",
        "[1:v]scale=250:-2[wm];[0:v][wm]overlay=W-w-24:H-h-24:format=auto,format=yuv420p[v]",
        "-map", "[v]",
        "-map", "0:a?",
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "23",
        "-c:a", "copy",
        "-movflags", "+faststart",
        "-max_muxing_queue_size", "2048",
        output,
    ]);
}

function encodeCopySource(bucket, key) {
    return `/${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

async function processRecord(record) {
    if (!HANDLED_EVENTS.has(record.eventName)) {
        console.log("Skipping event:", record.eventName);
        return;
    }

    // S3 URL-encodes keys in events, and spaces arrive as "+".
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));

    if (key.startsWith(TEMP_PREFIX) || key === WATERMARK_KEY) {
        console.log("Skipping excluded key:", key);
        return;
    }

    const head = await s3.send(
        new HeadObjectCommand({ Bucket: BUCKET, Key: key })
    );

    if (head.Metadata?.watermarked === "true") {
        console.log("Already watermarked:", key);
        return;
    }

    const media = resolveMedia(key, head.ContentType);
    if (!media) {
        console.log("Skipping unsupported file:", key, head.ContentType);
        return;
    }

    const id = randomUUID();
    const workDir = path.join("/tmp", id);
    await mkdir(workDir, { recursive: true });

    const inputPath = path.join(workDir, `input${media.ext}`);
    const outputPath = path.join(workDir, `output${media.ext}`);
    const logoPath = path.join(workDir, "logo.png");
    const tempKey = `${TEMP_PREFIX}${id}${media.ext}`;

    let tempUploaded = false;

    try {
        await Promise.all([
            downloadObject(key, inputPath),
            downloadObject(WATERMARK_KEY, logoPath),
        ]);

        if (media.kind === "video") {
            await watermarkVideo(inputPath, outputPath, logoPath);
        } else {
            await watermarkImage(inputPath, outputPath, logoPath, media.ext);
        }

        const outputStat = await stat(outputPath);

        // 1. Upload the result to a temporary key.
        await s3.send(
            new PutObjectCommand({
                Bucket: BUCKET,
                Key: tempKey,
                Body: createReadStream(outputPath),
                ContentLength: outputStat.size,
                ContentType: media.contentType,
                Metadata: { watermarked: "true", originalkey: key },
            })
        );
        tempUploaded = true;

        // 2. Server-side copy it over the original key.
        const copyParams = {
            Bucket: BUCKET,
            Key: key,
            CopySource: encodeCopySource(BUCKET, tempKey),
            MetadataDirective: "REPLACE",
            Metadata: { ...(head.Metadata || {}), watermarked: "true" },
            ContentType: media.contentType, // always a viewable type
        };

        if (head.CacheControl) copyParams.CacheControl = head.CacheControl;
        if (head.ContentLanguage) copyParams.ContentLanguage = head.ContentLanguage;
        if (head.Expires) copyParams.Expires = head.Expires;
        // Keep "inline; filename=..." but drop "attachment", which would make
        // browsers download the file instead of displaying it.
        if (
            head.ContentDisposition &&
            !/^\s*attachment/i.test(head.ContentDisposition)
        ) {
            copyParams.ContentDisposition = head.ContentDisposition;
        }

        await s3.send(new CopyObjectCommand(copyParams));

        console.log("Watermarking complete:", key);
    } finally {
        // 3. Always clean up, even if something above failed.
        if (tempUploaded) {
            try {
                await s3.send(
                    new DeleteObjectCommand({ Bucket: BUCKET, Key: tempKey })
                );
            } catch (error) {
                console.error("Temporary S3 cleanup failed:", error);
            }
        }
        await rm(workDir, { recursive: true, force: true });
    }
}

export const handler = async (event) => {
    if (!BUCKET) {
        throw new Error("BUCKET_NAME environment variable is missing");
    }

    const records = event.Records || [];

    const results = await Promise.allSettled(
        records.map((record) =>
            processRecord(record).catch((error) => {
                throw new Error(
                    `Failed on key "${record.s3?.object?.key}": ${error.message}`,
                    { cause: error }
                );
            })
        )
    );

    const failures = results.filter((r) => r.status === "rejected");
    for (const failure of failures) {
        console.error("Record processing failed:", failure.reason);
    }

    if (failures.length > 0) {
        throw new Error(
            `${failures.length} of ${records.length} S3 record(s) failed`
        );
    }

    return {
        statusCode: 200,
        body: JSON.stringify({
            processed: records.length,
            message: "Media processing finished",
        }),
    };
};
