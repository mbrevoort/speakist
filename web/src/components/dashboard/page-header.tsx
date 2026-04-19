// Shared header for dashboard sub-pages. Title + optional description +
// optional actions on the right. Small helper to keep the Members /
// Settings pages from duplicating the layout.

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <header className="flex flex-col sm:flex-row sm:items-end gap-4 sm:justify-between mb-8">
      <div>
        <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight">{title}</h1>
        {description && (
          <p className="mt-1.5 text-sm text-muted-foreground max-w-xl">
            {description}
          </p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </header>
  );
}
