import type { ReactNode } from 'react';

interface CardProps {
  title?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  flush?: boolean;
}

export function Card({ title, icon, actions, children, flush }: CardProps) {
  return (
    <section className="card">
      {title !== undefined || actions ? (
        <header className="card-header">
          <h2 className="card-title">
            {icon}
            {title}
          </h2>
          {actions ? <div className="row">{actions}</div> : null}
        </header>
      ) : null}
      <div className={`card-body${flush ? ' flush' : ''}`}>{children}</div>
    </section>
  );
}
