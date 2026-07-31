import type { ReactNode } from "react";

export type UnknownRow = Record<string, unknown>;

export const value = (input: unknown) => String(input ?? "—");
export const dateTime = (input: unknown) =>
  input ? new Date(String(input)).toLocaleString("zh-CN") : "—";

export function DataTable({
  rows,
  columns
}: {
  rows: UnknownRow[];
  columns: Array<{
    key: string;
    label: string;
    render?: (row: UnknownRow) => ReactNode;
  }>;
}) {
  return (
    <div className="admin-table-wrap">
      <table className="admin-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key}>{column.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length ? (
            rows.map((row, index) => (
              <tr key={String(row.id || row.event_name || index)}>
                {columns.map((column) => (
                  <td key={column.key}>
                    {column.render ? column.render(row) : value(row[column.key])}
                  </td>
                ))}
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={columns.length}>暂无数据</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
