interface EmptyStateProps {
  title: string;
  description: string;
}

export function EmptyState({ title, description }: EmptyStateProps) {
  return (
    <div className="flex h-full min-h-64 flex-col items-center justify-center rounded-lg border border-dashed border-white/15 px-6 py-16 text-center">
      <h2 className="text-base font-medium">{title}</h2>
      <p className="mt-2 max-w-md text-sm text-clean-white/60">{description}</p>
    </div>
  );
}
