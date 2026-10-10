import type { ReactNode } from 'react';

interface PageHeaderProps {
  title: ReactNode;
  description?: string;
  extra?: ReactNode;
}

export function PageHeader({ title, description, extra }: PageHeaderProps) {
  return (
    <header className="page-header">
      <div className="row-between">
        <h1 className="page-title">{title}</h1>
        {extra ? <div className="row">{extra}</div> : null}
      </div>
      {description ? <p className="page-desc">{description}</p> : null}
    </header>
  );
}
