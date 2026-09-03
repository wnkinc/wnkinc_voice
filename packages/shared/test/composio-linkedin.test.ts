import { describe, expect, it, vi } from 'vitest';
import { linkedinAdapterOn } from '../src/composio.js';

function fakeExecute(replies: Record<string, unknown | (() => never)> = {}) {
  const calls: Array<{ slug: string; args: Record<string, unknown> }> = [];
  const execute = vi.fn(async (slug: string, args: Record<string, unknown>) => {
    calls.push({ slug, args });
    const r = replies[slug];
    if (typeof r === 'function') (r as () => never)();
    return (r ?? {}) as Record<string, unknown>;
  });
  return { execute, calls };
}

const me = { response_data: { sub: 'abc123', name: 'Wes K', localizedHeadline: 'Owner at WNK', email: 'wes@example.com' } };

describe('composio LinkedIn adapter', () => {
  it('reads the profile from the OpenID userinfo shape and caches it', async () => {
    const { execute, calls } = fakeExecute({ LINKEDIN_GET_MY_INFO: me });
    const li = linkedinAdapterOn(execute);
    expect(await li.profile()).toEqual({ id: 'abc123', name: 'Wes K', headline: 'Owner at WNK', email: 'wes@example.com' });
    await li.profile();
    expect(calls.filter((c) => c.slug === 'LINKEDIN_GET_MY_INFO')).toHaveLength(1);
  });

  it('does not cache a failed profile lookup', async () => {
    let n = 0;
    const execute = vi.fn(async () => (n++ === 0 ? {} : me) as Record<string, unknown>);
    const li = linkedinAdapterOn(execute);
    await expect(li.profile()).rejects.toThrow(/no member id/);
    expect((await li.profile()).id).toBe('abc123');
  });

  it('posts as the connected member, published, public by default', async () => {
    const { execute, calls } = fakeExecute({ LINKEDIN_GET_MY_INFO: me, LINKEDIN_CREATE_LINKED_IN_POST: { post_id: 'urn:li:share:777' } });
    const got = await linkedinAdapterOn(execute).createPost({ text: 'hello' });
    expect(got).toEqual({ urn: 'urn:li:share:777' });
    expect(calls.find((c) => c.slug === 'LINKEDIN_CREATE_LINKED_IN_POST')?.args).toEqual({
      author: 'urn:li:person:abc123', commentary: 'hello', visibility: 'PUBLIC', lifecycleState: 'PUBLISHED',
    });
  });

  it('reports a post that came back without an id as published, not failed', async () => {
    const { execute } = fakeExecute({ LINKEDIN_GET_MY_INFO: me, LINKEDIN_CREATE_LINKED_IN_POST: { successful: true } });
    const got = await linkedinAdapterOn(execute).createPost({ text: 'hello', visibility: 'CONNECTIONS' });
    expect(got.urn).toBeUndefined();
    expect(got.raw).toEqual({ successful: true });
  });

  it('reads a post back with its reaction count; a bare id is a share', async () => {
    const { execute, calls } = fakeExecute({
      LINKEDIN_GET_POST_CONTENT: { response_data: { commentary: 'hello', visibility: 'PUBLIC', createdAt: 1_700_000_000_000 } },
      LINKEDIN_LIST_REACTIONS: { paging: { total: 4 }, elements: [{}] },
    });
    const post = await linkedinAdapterOn(execute).getPost('777');
    expect(post).toEqual({ urn: 'urn:li:share:777', text: 'hello', visibility: 'PUBLIC', createdAt: '2023-11-14T22:13:20.000Z', reactions: 4 });
    expect(calls.map((c) => c.slug)).toEqual(['LINKEDIN_GET_POST_CONTENT', 'LINKEDIN_LIST_REACTIONS']);
  });

  it('returns undefined for a post it cannot read, and tolerates a reactions failure', async () => {
    const boom = () => { throw new Error('404'); };
    expect(await linkedinAdapterOn(fakeExecute({ LINKEDIN_GET_POST_CONTENT: boom }).execute).getPost('urn:li:ugcPost:1')).toBeUndefined();
    const post = await linkedinAdapterOn(fakeExecute({ LINKEDIN_GET_POST_CONTENT: { text: 'x' }, LINKEDIN_LIST_REACTIONS: boom }).execute).getPost('urn:li:ugcPost:1');
    expect(post).toEqual({ urn: 'urn:li:ugcPost:1', text: 'x', visibility: undefined, createdAt: undefined, reactions: undefined });
  });

  it('deletes by urn', async () => {
    const { execute, calls } = fakeExecute();
    await linkedinAdapterOn(execute).deletePost('urn:li:share:777');
    expect(calls).toEqual([{ slug: 'LINKEDIN_DELETE_POST', args: { post_urn: 'urn:li:share:777' } }]);
  });
});
