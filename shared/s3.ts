/**
 * S3 access, shared by backend (presign, delete) and worker (upload).
 *
 * A factory rather than a module-level singleton because the two services
 * validate their own environments; passing config in keeps this file free of
 * env coupling and trivially testable.
 */
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3'

export interface S3Config {
  endpoint: string
  region: string
  bucket: string
  accessKey: string
  secretKey: string
  forcePathStyle: boolean
}

export function makeS3(cfg: S3Config) {
  const client = new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region,
    credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
    // MinIO addresses buckets by path; real S3 uses virtual-host style.
    forcePathStyle: cfg.forcePathStyle,
  })

  return {
    client,
    bucket: cfg.bucket,

    async upload(key: string, body: NonNullable<ConstructorParameters<typeof PutObjectCommand>[0]['Body']>, contentType: string, contentLength?: number) {
      await client.send(
        new PutObjectCommand({
          Bucket: cfg.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          ContentLength: contentLength,
        }),
      )
      return key
    },

    /** Presigned GET. Callers set their own expiry; default one hour. */
    async presign(key: string, expiresIn = 3600) {
      const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner')
      return getSignedUrl(client, new GetObjectCommand({ Bucket: cfg.bucket, Key: key }), {
        expiresIn,
      })
    },

    async exists(key: string): Promise<boolean> {
      try {
        await client.send(new HeadObjectCommand({ Bucket: cfg.bucket, Key: key }))
        return true
      } catch {
        return false
      }
    },

    /**
     * `range` is an HTTP byte-range string ("bytes=0-499"), passed straight
     * through to S3 so a seek fetches only the bytes it needs instead of the
     * whole object.
     */
    async getStream(key: string, range?: string) {
      const res = await client.send(
        new GetObjectCommand({ Bucket: cfg.bucket, Key: key, Range: range }),
      )
      return res.Body as NodeJS.ReadableStream
    },

    /** Batch delete. S3 caps DeleteObjects at 1000 keys, so chunk. */
    async deleteMany(keys: string[]) {
      for (let i = 0; i < keys.length; i += 1000) {
        const chunk = keys.slice(i, i + 1000)
        if (chunk.length === 0) continue
        await client.send(
          new DeleteObjectsCommand({
            Bucket: cfg.bucket,
            Delete: { Objects: chunk.map((Key) => ({ Key })) },
          }),
        )
      }
    },
  }
}

export type S3 = ReturnType<typeof makeS3>

/** Object key layout. Kept in one place so backend and worker cannot drift. */
export const keys = {
  render: (jobId: string, clipId: string, ratio: string) =>
    `jobs/${jobId}/clips/${clipId}/${ratio.replace(':', 'x')}.mp4`,
  thumb: (jobId: string, clipId: string, ratio: string) =>
    `jobs/${jobId}/clips/${clipId}/${ratio.replace(':', 'x')}.jpg`,
  srt: (videoId: string) => `transcripts/${videoId}.srt`,
  /** Low-resolution cut of the editor timeline window, for scrubbing. */
  proxy: (jobId: string, clipId: string) => `jobs/${jobId}/clips/${clipId}/proxy.mp4`,
  /** Filmstrip sprite for that window: N frames tiled into one JPEG. */
  strip: (jobId: string, clipId: string) => `jobs/${jobId}/clips/${clipId}/strip.jpg`,

  /**
   * Full-length editor assets, keyed by VIDEO rather than by job.
   *
   * Videos are deduplicated by URL, so these are shared by every job and every
   * user built from the same source -- the same reason the transcript above is
   * keyed this way.
   */
  sourceProxy: (videoId: string) => `videos/${videoId}/proxy.mp4`,
  sourceStrip: (videoId: string) => `videos/${videoId}/strip.jpg`,
  /** Full source video download, cached in S3 for any worker to reuse. */
  sourceVideo: (videoId: string) => `videos/${videoId}/source.mp4`,
}
