// packages/web/src/app/admin/scrapers/page.tsx
'use client';

import { useEffect, useState } from 'react';

// Define types to match the backend
interface PlatformConfig {
  platform_id: string;
  is_enabled: boolean;
  selectors: any;
  last_updated_at: string;
  updated_by: string;
}

interface ScraperBugReport {
  id: string;
  platform_id: string;
  error_message: string;
  href: string;
  user_id: string;
  reported_at: string;
  status: string;
}

// Component to edit a single platform's config
function PlatformEditor({ config, onSave }: { config: PlatformConfig, onSave: (config: PlatformConfig) => Promise<void> }) {
  const [selectors, setSelectors] = useState(JSON.stringify(config.selectors, null, 2));
  const [isEnabled, setIsEnabled] = useState(config.is_enabled);
  const [isSaving, setIsSaving] = useState(false);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const parsedSelectors = JSON.parse(selectors);
      await onSave({ ...config, selectors: parsedSelectors, is_enabled: isEnabled });
    } catch (e) {
      alert('Invalid JSON in selectors');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div style={{ border: '1px solid #ccc', padding: '1rem', borderRadius: '8px' }}>
      <h3>{config.platform_id}</h3>
      <div>
        <label>
          <input type="checkbox" checked={isEnabled} onChange={e => setIsEnabled(e.target.checked)} />
          Enabled
        </label>
      </div>
      <div style={{ marginTop: '0.5rem' }}>
        <textarea 
          value={selectors} 
          onChange={e => setSelectors(e.target.value)} 
          rows={10} 
          style={{ width: '100%', fontFamily: 'monospace' }}
        />
      </div>
      <button onClick={handleSave} disabled={isSaving} style={{ marginTop: '0.5rem' }}>
        {isSaving ? 'Saving...' : 'Save'}
      </button>
      <small style={{ display: 'block', marginTop: '0.5rem', color: '#666' }}>
        Last updated: {new Date(config.last_updated_at).toLocaleString()} by {config.updated_by}
      </small>
    </div>
  );
}

// Component to display bug reports
function BugReportViewer({ reports }: { reports: ScraperBugReport[] }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead>
        <tr>
          <th style={{ border: '1px solid #ccc', padding: '8px', textAlign: 'left' }}>Platform</th>
          <th style={{ border: '1px solid #ccc', padding: '8px', textAlign: 'left' }}>Error</th>
          <th style={{ border: '1px solid #ccc', padding: '8px', textAlign: 'left' }}>URL</th>
          <th style={{ border: '1px solid #ccc', padding: '8px', textAlign: 'left' }}>Reported At</th>
        </tr>
      </thead>
      <tbody>
        {reports.map(report => (
          <tr key={report.id}>
            <td style={{ border: '1px solid #ccc', padding: '8px' }}>{report.platform_id}</td>
            <td style={{ border: '1px solid #ccc', padding: '8px' }}>{report.error_message}</td>
            <td style={{ border: '1px solid #ccc', padding: '8px' }}><a href={report.href} target="_blank" rel="noopener noreferrer">Link</a></td>
            <td style={{ border: '1px solid #ccc', padding: '8px' }}>{new Date(report.reported_at).toLocaleString()}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function ScraperAdminPage() {
  const [configs, setConfigs] = useState<PlatformConfig[]>([]);
  const [reports, setReports] = useState<ScraperBugReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true);
        const [configsRes, reportsRes] = await Promise.all([
          fetch('/api/scraper-admin/configs'),
          fetch('/api/scraper-admin/bug-reports'),
        ]);

        if (!configsRes.ok || !reportsRes.ok) {
          throw new Error('Failed to fetch data');
        }

        const [configsData, reportsData] = await Promise.all([
          configsRes.json(),
          reportsRes.json(),
        ]);

        setConfigs(configsData);
        setReports(reportsData);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'An unknown error occurred');
      } finally {
        setLoading(false);
      }
    };
    void fetchData();
  }, []);

  const handleSaveConfig = async (configToSave: PlatformConfig) => {
    const res = await fetch('/api/scraper-admin/configs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(configToSave),
    });
    if (!res.ok) {
      alert('Failed to save config');
    } else {
      // Refresh data on successful save
      const newConfigs = configs.map(c => c.platform_id === configToSave.platform_id ? configToSave : c);
      setConfigs(newConfigs);
    }
  };

  if (loading) return <div>Loading...</div>;
  if (error) return <div>Error: {error}</div>;

  return (
    <div style={{ padding: '2rem' }}>
      <h1>Scraper Admin</h1>
      
      <h2>Platform Configurations</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(400px, 1fr))', gap: '1rem' }}>
        {configs.map(config => (
          <PlatformEditor key={config.platform_id} config={config} onSave={handleSaveConfig} />
        ))}
      </div>

      <h2 style={{ marginTop: '2rem' }}>Bug Reports ({reports.length})</h2>
      <BugReportViewer reports={reports} />
    </div>
  );
}
