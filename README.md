# AWS Media Watermark

An AWS Lambda function that automatically adds a PNG watermark to images and videos uploaded to Amazon S3.

The function processes supported media after it is uploaded, writes a temporary copy to S3, copies the watermarked result back over the original object, and deletes the temporary copy.

## Supported media

| Type | Extensions |
| --- | --- |
| Images | `.jpg`, `.jpeg`, `.png`, `.webp` |
| Videos | `.mp4` |

Files without a supported extension are detected from their S3 `Content-Type` when possible.

## How it works

1. An S3 `ObjectCreated` event invokes the Lambda function.
2. The function downloads the uploaded media and the watermark PNG.
3. Images are processed by `sharp`; videos are processed by FFmpeg.
4. The watermark is placed in the bottom-right corner.
5. The result is uploaded to a temporary S3 key.
6. The result is copied over the original S3 object.
7. The temporary object is deleted.

The function skips unsupported files, temporary objects, the watermark itself, copy events, and objects already marked with `watermarked=true`.

## Lambda configuration

### Runtime

- Node.js 20 or newer
- ARM64 or x86-64, matching the packaged native dependencies
- `/tmp` storage for downloaded and processed files

The Sharp package contains native binaries and must be installed for the architecture used by Lambda.

### Environment variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `BUCKET_NAME` | Yes | - | S3 bucket containing media and the watermark |
| `WATERMARK_KEY` | No | `watermark-assets/LeksyMark.png` | S3 key for the watermark PNG |
| `TEMP_PREFIX` | No | `watermark-tmp/` | Prefix used for temporary processed objects |

### FFmpeg layer

The application expects FFmpeg at `/opt/bin/ffmpeg`. Use `ffmpeg-layer/bin/ffmpeg` to package an FFmpeg Lambda layer, with the executable at the layer root under `bin/ffmpeg`.

For example:

```powershell
Compress-Archive -Path ffmpeg-layer\bin -DestinationPath ffmpeg-layer.zip
```

Configure the resulting ZIP as a Lambda layer and attach it to the function.

## S3 setup

Upload the watermark image first, for example:

```text
watermark-assets/LeksyMark.png
```

The watermark should be a PNG image.

Configure an S3 event notification for object creation events and point it to the Lambda function:

- `ObjectCreated:Put`
- `ObjectCreated:Post`
- `ObjectCreated:CompleteMultipartUpload`

You can leave the object prefix and suffix unrestricted, but each processed file must be a supported media type.

## IAM permissions

The Lambda execution role needs the following S3 actions on the bucket:

- `s3:GetObject`
- `s3:HeadObject`
- `s3:PutObject`
- `s3:GetObject` for the server-side copy source
- `s3:CopyObject`
- `s3:DeleteObject`

In AWS policy terms, `CopyObject` may require both bucket and object resources to be authorized. The role must also have permission to invoke the Lambda function from S3:

- `lambda:InvokeFunction`

## Packaging the application

From the repository root:

```powershell
cd app
npm install
Compress-Archive -Path index.mjs,package.json,package-lock.json,node_modules -DestinationPath ..\aws-media-watermark.zip
```

Upload `aws-media-watermark.zip` as the Lambda function deployment package. Set the handler to:

```text
index.handler
```

Package Sharp by running `npm install` on a system matching the Lambda runtime architecture, or build the Lambda package in a Lambda-compatible Linux environment.

## Local development

FFmpeg is only available at `/opt/bin/ffmpeg` in the Lambda environment. The Node.js application is intended to run as a Lambda handler rather than as a standalone server.

Install application dependencies with:

```powershell
cd app
npm install
```

## Processing behavior

- Images are rotated using EXIF orientation before the watermark is applied.
- Image watermarks fit within 25% of the image width and 25% of the image height.
- JPEG and WebP images are encoded with quality `88`.
- PNG images remain PNG files.
- Video watermarks are scaled to a width of 250 pixels.
- Videos are re-encoded with H.264 at CRF `23`.
- The audio stream is copied without re-encoding.
- Processed objects receive S3 metadata key `watermarked=true`.
- Supported media types are JPEG, PNG, WebP, and MP4.

## Project structure

```text
app/
  index.mjs       Lambda handler and media processing logic
  package.json    Lambda application dependencies
ffmpeg-layer/
  bin/ffmpeg      FFmpeg binary packaged in a Lambda layer
  package.json    FFmpeg dependency setup
```
