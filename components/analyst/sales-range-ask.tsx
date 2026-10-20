'use client';

import {useState} from 'react';
import {ArrowUp, Sparkles} from 'lucide-react';
import {Card, CardContent} from '@/components/ui/card';
import {useCoopChat} from './coop-chat';

/**
 * Quick chat for the Sales range view: a question box and four chips that open the existing Ask Coop drawer. Nothing runs until
 * someone asks, and the answers, number check and rate limit are Ask Coop's own. The page's dates reach the chat through the
 * page context it already sends with every question.
 */
export function SalesRangeAsk({label, hasPrevious}: {label: string; hasPrevious: boolean}) {
  const {ask} = useCoopChat();
  const [q, setQ] = useState('');
  const chips = [
    hasPrevious ? 'What changed compared with the span before?' : 'How did each channel do in this span?',
    'Which channel dropped most?',
    'Where is ad spend not paying back?',
    'Which weeks have complete figures?',
  ];
  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-4">
        <div className="flex items-center gap-1.5 text-sm font-semibold">
          <Sparkles className="size-4 text-primary" />
          Ask Coop about {label}
        </div>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!q.trim()) return;
            ask(q);
            setQ('');
          }}
        >
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Ask Coop about these dates"
            placeholder="Ask about these dates..."
            className="min-w-0 flex-1 rounded-full border border-border bg-card px-4 py-2 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring/40"
          />
          <button
            type="submit"
            aria-label="Ask"
            disabled={!q.trim()}
            className="grid size-9 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground transition-colors duration-150 ease-out hover:bg-primary/90 active:scale-[0.97] disabled:opacity-40"
          >
            <ArrowUp className="size-4" />
          </button>
        </form>
        <div className="flex flex-col gap-2">
          {chips.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => ask(c)}
              className="rounded-xl border border-primary/30 bg-primary/[0.07] px-3 py-2 text-left text-[13px] text-foreground transition-colors duration-150 ease-out hover:bg-primary/[0.12] active:scale-[0.99]"
            >
              {c}
            </button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
