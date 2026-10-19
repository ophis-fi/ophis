import type {ReactNode} from 'react';
import Link from '@docusaurus/Link';

// Icon cards and numbered steps for the docs pages. Icons are the .icon-<name>
// classes in src/css/icons.css. Registered for every page in src/theme/MDXComponents.tsx.

export function Cards({children}: {children: ReactNode}) {
  return <div className="doc-cards">{children}</div>;
}

export function Card({icon, title, href, children}: {icon: string; title: string; href?: string; children?: ReactNode}) {
  const body = (
    <>
      <span className={`doc-card-icon icon-${icon}`} aria-hidden="true">
        <span className="doc-icon" />
      </span>
      <span>
        <strong>{title}</strong>
        {children && <small>{children}</small>}
      </span>
    </>
  );
  return href ? <Link className="doc-card" to={href}>{body}</Link> : <div className="doc-card">{body}</div>;
}

export function Steps({children}: {children: ReactNode}) {
  return <div className="steps">{children}</div>;
}
