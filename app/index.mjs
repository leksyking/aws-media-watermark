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
import { 
  createReadStream, 
  createWriteStream, 
} from "node:fs"; 
import { mkdir, rm, stat } from "node:fs/promises"; 
import path from "node:path"; 
import { pipeline } from "node:stream/promises"; 
 
const s3 = new S3Client({}); 
const BUCKET = process.env.BUCKET_NAME; 
const WATERMARK_KEY = 
  process.env.WATERMARK_KEY || "watermark-assets/LeksyMark.png"; 
const TEMP_PREFIX = 
  process.env.TEMP_PREFIX || "watermark-tmp/"; 
 
const FFMPEG = "/opt/bin/ffmpeg"; 
 
async function downloadObject(key, destination) { 
  const result = await s3.send( 
    new GetObjectCommand({ 
      Bucket: BUCKET, 
      Key: key, 
    }) 
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
 
      // Avoid accumulating unlimited diagnostic output. 
      if (stderr.length > 20000) { 
        stderr = stderr.slice(-20000); 
      } 
    }); 
 
    child.on("error", reject); 
 
    child.on("close", (code) => { 
      if (code === 0) { 
        resolve(); 
      } else { 
        reject( 
          new Error(`FFmpeg exited with code ${code}: ${stderr}`) 
        ); 
      } 
    }); 
  }); 
} 
 
async function watermarkImage(input, output, logo, ext) {
  // Bake EXIF orientation into the pixels first
  const orientedBuffer = await sharp(input).rotate().toBuffer();
  const metadata = await sharp(orientedBuffer).metadata();

  if (!metadata.width || !metadata.height) {
    throw new Error("Could not determine image dimensions");
  }

  const logoWidth = Math.max(1, Math.round(metadata.width * 0.40));

  const watermark = await sharp(logo)
    .resize({ width: logoWidth, withoutEnlargement: true })
    .png()
    .toBuffer();

  const margin = Math.max(
    8,
    Math.round(Math.min(metadata.width, metadata.height) * 0.025)
  );

  // Place the logo bottom-right using the margin
  const wmMeta = await sharp(watermark).metadata();
  const left = Math.max(0, metadata.width - wmMeta.width - margin);
  const top = Math.max(0, metadata.height - wmMeta.height - margin);

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
    "-i", input, 
    "-i", logo, 
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
 
function contentTypeFor(ext, originalType) { 
  const types = { 
    ".jpg": "image/jpeg", 
    ".jpeg": "image/jpeg", 
    ".png": "image/png", 
    ".webp": "image/webp", 
    ".mp4": "video/mp4", 
  }; 
 
  return types[ext] || originalType || "application/octet-stream"; 
} 
 
function encodeCopySource(bucket, key) { 
  return `/${bucket}/${key 
    .split("/") 
    .map(encodeURIComponent) 
    .join("/")}`; 
} 
 
async function processRecord(record) { 
  if (!record.eventName?.endsWith(":Put")) { 
    console.log("Skipping non-Put event:", record.eventName); 
    return; 
  } 
 
  const key = decodeURIComponent( 
    record.s3.object.key.replace(/\+/g, " ") 
  ); 
 
  if ( 
    key.startsWith(TEMP_PREFIX) || 
    key === WATERMARK_KEY 
  ) { 
    console.log("Skipping excluded key:", key); 
    return; 
  } 
 
  const ext = path.extname(key).toLowerCase(); 
  const supported = [ 
    ".jpg", ".jpeg", ".png", ".webp", ".mp4", 
  ]; 
 
  if (!supported.includes(ext)) { 
    console.log("Skipping unsupported file:", key); 
    return; 
  } 
 
  const head = await s3.send( 
    new HeadObjectCommand({ 
      Bucket: BUCKET, 
      Key: key, 
    }) 
  ); 
 
  if (head.Metadata?.watermarked === "true") { 
    console.log("Already watermarked:", key); 
    return; 
  } 
 
  const id = randomUUID(); 
  const workDir = path.join("/tmp", id); 
  await mkdir(workDir, { recursive: true }); 
 
  const inputPath = path.join(workDir, `input${ext}`); 
  const outputPath = path.join(workDir, `output${ext}`); 
  const logoPath = path.join(workDir, "logo.png"); 
  const tempKey = `${TEMP_PREFIX}${id}${ext}`; 
 
  let tempUploaded = false; 
 
  try { 
    await Promise.all([ 
      downloadObject(key, inputPath), 
      downloadObject(WATERMARK_KEY, logoPath), 
    ]); 
 
    if (ext === ".mp4") { 
      await watermarkVideo(inputPath, outputPath, logoPath); 
    } else { 
      await watermarkImage(inputPath, outputPath, logoPath, ext); 
    } 
 
    const outputStat = await stat(outputPath); 
    const contentType = contentTypeFor(ext, head.ContentType); 
 
    await s3.send( 
      new PutObjectCommand({ 
        Bucket: BUCKET, 
        Key: tempKey, 
        Body: createReadStream(outputPath), 
        ContentLength: outputStat.size, 
        ContentType: contentType, 
        Metadata: { 
          watermarked: "true", 
          originalkey: key, 
        }, 
      }) 
    ); 
 
    tempUploaded = true; 
 
    const copyParams = { 
      Bucket: BUCKET, 
      Key: key, 
      CopySource: encodeCopySource(BUCKET, tempKey), 
      MetadataDirective: "REPLACE", 
      Metadata: { 
        ...(head.Metadata || {}), 
        watermarked: "true", 
      }, 
      ContentType: contentType, 
    }; 
 
    if (head.CacheControl) copyParams.CacheControl = head.CacheControl; 
    if (head.ContentDisposition) { 
      copyParams.ContentDisposition = head.ContentDisposition; 
    } 
    if (head.ContentLanguage) { 
      copyParams.ContentLanguage = head.ContentLanguage; 
    } 
    if (head.Expires) copyParams.Expires = head.Expires; 
 
    await s3.send(new CopyObjectCommand(copyParams)); 
 
    console.log("Watermarking complete:", key); 
  } finally { 
    if (tempUploaded) { 
      try { 
        await s3.send( 
          new DeleteObjectCommand({ 
            Bucket: BUCKET, 
            Key: tempKey, 
          }) 
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
    records.map(processRecord) 
  ); 
 
  const failures = results.filter( 
    (result) => result.status === "rejected" 
  ); 
 
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
