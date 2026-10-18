import { useMemo } from 'react';
import { feedThreads } from '@gnomi/engine/graph/feed.ts';
import type { FeedPost } from '@gnomi/engine/graph/feed.ts';
import type { GnomiEvent } from '@gnomi/simulation/types.ts';

interface Props {
  names: Map<string, string>;
  pois?: { id: string; name: string }[];
  onOpen(personaId: string): void;
}

function Post({ post, ...props }: Props & { post: FeedPost }) {
  const { names, pois, onOpen } = props;
  const author = post.author;
  return (
    <li className="space-y-1">
      <p className="flex flex-wrap items-baseline gap-x-2 text-xs text-stone-500">
        {author ? (
          <button type="button" onClick={() => onOpen(author)} className="text-sm font-medium text-stone-900 underline-offset-2 hover:underline">
            {names.get(author) ?? author}
          </button>
        ) : (
          <span className="text-sm font-medium text-stone-900">Unknown author</span>
        )}
        <span>Round {post.round}</span>
        {post.about_poi_id && <span>About {pois?.find((poi) => poi.id === post.about_poi_id)?.name ?? post.about_poi_id}</span>}
        {post.injected && <span className="rounded border border-amber-300 bg-amber-50 px-1.5 text-amber-900">Injected by the test harness</span>}
      </p>
      <p className="whitespace-pre-wrap break-words text-sm text-stone-800">{post.text}</p>
      <p className="text-xs text-stone-500">{post.reactions.agree} agree · {post.reactions.disagree} disagree</p>
      {post.replies.length > 0 && (
        <ul aria-label="Replies" className="mt-2 space-y-3 border-l-2 border-stone-200 pl-4">
          {post.replies.map((reply) => <Post key={reply.post_id} post={reply} {...props} />)}
        </ul>
      )}
    </li>
  );
}

/** The run's swarm feed (tech.md §6.6) as threads, newest first. Posts are text, never HTML (tech.md §13). */
export function Feed({ events, ...props }: Props & { events: GnomiEvent[] }) {
  const threads = useMemo(() => feedThreads(events).reverse(), [events]);
  return (
    <section aria-label="Feed" className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
      <h2 className="mb-3 text-base font-semibold text-stone-900">Feed ({threads.length} threads)</h2>
      {threads.length === 0 ? (
        <p className="text-sm text-stone-500">No posts yet. Personas post during social rounds; runs without social rounds have none.</p>
      ) : (
        <ul className="max-h-[32rem] space-y-4 divide-y divide-stone-100 overflow-y-auto pr-1 [&>li]:pt-4 [&>li:first-child]:pt-0">
          {threads.map((post) => <Post key={post.post_id} post={post} {...props} />)}
        </ul>
      )}
    </section>
  );
}
