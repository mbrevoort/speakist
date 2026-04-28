// Shared header for dashboard sub-pages. Title + optional description +
// optional actions on the right. Small helper to keep the Members /
// Settings pages from duplicating the layout.
//
// `description` is typed as `ReactNode` so callers can mix plain text
// with components — particularly `<LocalTime>` for the user's-local-
// timezone-formatted creation/joined timestamps that admin pages
// thread through here.

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: React.ReactNode;
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
