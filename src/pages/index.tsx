import type {ReactNode} from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';

import styles from './index.module.css';

function HomepageHeader() {
  const {siteConfig} = useDocusaurusContext();
  return (
    <header className={clsx('hero hero--primary', styles.heroBanner)}>
      <div className="container">
        <Heading as="h1" className="hero__title">
          {siteConfig.title}
        </Heading>
        <p className="hero__subtitle">{siteConfig.tagline}</p>
        <div className={styles.buttons}>
          <Link
            className="button button--secondary button--lg"
            to="/docs/SORA_architecture_v4_4">
            Читать Архитектуру ➔
          </Link>
          <Link
            className="button button--outline button--secondary button--lg"
            style={{marginLeft: '20px'}}
            to="/docs/COMPLIANCE">
            Compliance ➔
          </Link>
        </div>
      </div>
    </header>
  );
}

export default function Home(): ReactNode {
  const {siteConfig} = useDocusaurusContext();
  return (
    <Layout
      title={`Advanced Security Auditor`}
      description="Spinty SORA - Signals Offensive Radio Auditor">
      <HomepageHeader />
      <main>
        {/* Placeholder for future features or terminal simulation UI */}
        <div style={{padding: '4rem 0', textAlign: 'center', opacity: 0.7}}>
            <h2>Offensive RF auditing for the modern era.</h2>
            <p>Phase 4 Architecture (Rust Core + Python Orchestration)</p>
        </div>
      </main>
    </Layout>
  );
}
