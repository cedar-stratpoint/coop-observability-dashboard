// DEV-ONLY preview of the environment switcher in both environments. 404 outside dev.
import {notFound} from 'next/navigation';
import {EnvStrip, EnvSwitcher} from '@/components/analyst/env-switcher';

export default function Page() {
  if (process.env.NODE_ENV !== 'development') notFound();
  return (
    <div className="flex flex-col gap-10 p-8">
      {(['staging', 'production'] as const).map((env) => (
        <div key={env} className="relative flex h-14 items-center gap-3 rounded-lg border bg-card px-4" data-env={env}>
          <EnvStrip env={env} />
          <span className="text-sm text-muted-foreground">Header on {env}:</span>
          <EnvSwitcher env={env} />
        </div>
      ))}
    </div>
  );
}
