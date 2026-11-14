import { z } from "zod";

export const messageSchema = z.object({
  id: z.uuid(),
  patternId: z.uuid(),
  number: z.number().int().positive(),
  body: z.string(),
  createdAt: z.iso.datetime(),
});

export function messageJson(t: string) {
  return `json_object('id', ${t}.id, 'patternId', ${t}.pattern_id,
    'number', ${t}.number, 'body', ${t}.body, 'createdAt', ${t}.created_at)`;
}
