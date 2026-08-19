import { css, type Handle, type Props } from "remix/ui";

export function Table(handle: Handle<Props<"table">>) {
  return () => {
    const { mix, ...props } = handle.props;
    return (
      <div data-slot="table-container" mix={tableContainerStyle}>
        <table {...props} data-slot="table" mix={[tableStyle, mix]} />
      </div>
    );
  };
}

export function TableHeader(handle: Handle<Props<"thead">>) {
  return () => {
    const { mix, ...props } = handle.props;
    return <thead {...props} data-slot="table-header" mix={[tableHeaderStyle, mix]} />;
  };
}

export function TableBody(handle: Handle<Props<"tbody">>) {
  return () => {
    const { mix, ...props } = handle.props;
    return <tbody {...props} data-slot="table-body" mix={[tableBodyStyle, mix]} />;
  };
}

export function TableRow(handle: Handle<Props<"tr">>) {
  return () => {
    const { mix, ...props } = handle.props;
    return <tr {...props} data-slot="table-row" mix={[tableRowStyle, mix]} />;
  };
}

export function TableHead(handle: Handle<Props<"th">>) {
  return () => {
    const { mix, ...props } = handle.props;
    return <th {...props} data-slot="table-head" mix={[tableHeadStyle, mix]} />;
  };
}

export function TableCell(handle: Handle<Props<"td">>) {
  return () => {
    const { mix, ...props } = handle.props;
    return <td {...props} data-slot="table-cell" mix={[tableCellStyle, mix]} />;
  };
}

const tableContainerStyle = css({
  position: "relative",
  width: "100%",
  overflow: "visible",
});
const tableStyle = css({
  width: "100%",
  captionSide: "bottom",
  borderCollapse: "collapse",
  fontSize: "14px",
});
const tableHeaderStyle = css({ "& tr": { borderBottom: "1px solid var(--border)" } });
const tableBodyStyle = css({ "& tr:last-child": { borderBottom: 0 } });
const tableRowStyle = css({
  borderBottom: "1px solid var(--border)",
  transition: "background-color 150ms ease",
  "&:hover": { background: "color-mix(in oklab, var(--muted) 50%, transparent)" },
});
const tableHeadStyle = css({
  height: "40px",
  padding: "0 12px",
  color: "var(--muted-foreground)",
  fontWeight: 500,
  textAlign: "left",
  whiteSpace: "nowrap",
});
const tableCellStyle = css({
  padding: "12px",
  verticalAlign: "middle",
  whiteSpace: "nowrap",
});
