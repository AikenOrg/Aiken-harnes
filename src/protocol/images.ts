import { z } from "zod";

/** 画像入力として受け付ける既定の MIME タイプ。 */
export const DEFAULT_IMAGE_MEDIA_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

export const imageAttachmentSchema = z.object({
  mediaType: z.string().regex(/^image\/[a-z0-9.+-]+$/),
  /** data URL ではなく base64 本体。 */
  data: z.string().min(1),
  name: z.string().max(200).optional(),
});

export type ImageAttachment = z.infer<typeof imageAttachmentSchema>;

export const imagesConfigSchema = z.object({
  /** 1 枚あたりのデコード後バイト数。 */
  maxBytes: z.number().int().positive().optional(),
  /** 1 メッセージあたりの枚数。 */
  maxCount: z.number().int().positive().optional(),
  /** 1 メッセージあたりの合計デコード後バイト数。 */
  maxTotalBytes: z.number().int().positive().optional(),
});

export type ImagesConfig = z.infer<typeof imagesConfigSchema>;
