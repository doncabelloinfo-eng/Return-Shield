/**
 * "Export PDF" — the tab on screen, as a sheet of paper.
 *
 * A plain link, not a button that posts: the browser saves the response and
 * stays on the screen, nothing is written, and the href is the screen's own
 * query string — so the file is whatever the tab, the search box, the shop and
 * the ship-date filter are showing. `page` is deliberately left out, because
 * the file is not paged; that is the whole point of it.
 *
 * It says the row count beside itself, and goes flat and unclickable on an
 * empty tab. A download that turns out to be empty is a worse answer than a
 * button that says there is nothing to download.
 */
export function ExportPdfButton({
  params, total,
}: {
  /** The screen's own search params, minus `page`. */
  params: Record<string, string | undefined>;
  total: number;
}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) query.set(key, value);
  }
  const href = `/api/parcels/export${query.toString() ? `?${query}` : ''}`;

  const shell = 'whitespace-nowrap rounded-[5px] border px-[11px] py-[7px]'
    + ' text-[11.5px] font-semibold no-underline';

  if (total === 0) {
    return (
      <span
        aria-disabled="true"
        className={`${shell} cursor-not-allowed border-line bg-surface2 text-muted opacity-70`}
      >
        Nothing to export
      </span>
    );
  }

  return (
    <a
      href={href}
      download
      title={`${total} ${total === 1 ? 'row' : 'rows'}, order and tracking only`}
      className={`${shell} border-navy bg-surface text-navy hover:bg-surface2`}
    >
      ⭳ Export PDF
    </a>
  );
}
