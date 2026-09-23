/** Texted photo ids -> links, through the media link resolver (packages/media-link), which refuses a photo not texted to this tenant's number. */
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import type { Photo } from '@wnk/shared/contracts';
import { env } from './config.js';

const lambda = new LambdaClient({});

export async function mintLinks(tenantPhone: string, media: Photo[]): Promise<string[]> {
  const links: string[] = [];
  for (const m of media) {
    const r = await lambda.send(new InvokeCommand({ FunctionName: env('MEDIA_LINK_FUNCTION_ARN'), Payload: JSON.stringify({ tenantPhone, messageSid: m.messageSid, mediaSid: m.mediaSid }) }));
    if (r.FunctionError) throw new Error(`media link: ${Buffer.from(r.Payload ?? []).toString().slice(0, 300)}`);
    const { url } = JSON.parse(Buffer.from(r.Payload ?? []).toString()) as { url?: string };
    if (!url) throw new Error('media link: no url');
    links.push(url);
  }
  return links;
}
