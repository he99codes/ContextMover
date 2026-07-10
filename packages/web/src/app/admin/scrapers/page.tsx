// packages/web/src/app/admin/scrapers/page.tsx
'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import DOMPurify from 'dompurify';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter, DialogClose } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { Toaster, toast } from 'sonner';

// Types
interface PlatformSelectors { [key: string]: string | undefined; }
interface PlatformConfig { platform_id: string; is_enabled: boolean; selectors: PlatformSelectors; last_updated_at: string; updated_by: string; }
interface ScraperBugReport { id: string; platform_id: string; error_message: string | null; href: string | null; user_id: string; created_at: string; status: string; dom_snippet?: string; }

// Editor Component
function PlatformEditor({ config, onSave }: { config: PlatformConfig, onSave: (config: PlatformConfig) => Promise<void> }) {
  const [selectors, setSelectors] = useState(JSON.stringify(config.selectors, null, 2));
  const [isEnabled, setIsEnabled] = useState(config.is_enabled);
  const [isSaving, setIsSaving] = useState(false);

  const handleSave = async () => {
    setIsSaving(true);
    const promise = new Promise<void>((resolve, reject) => {
      try {
        const parsedSelectors = JSON.parse(selectors);
        onSave({ ...config, selectors: parsedSelectors, is_enabled: isEnabled })
          .then(resolve)
          .catch(reject);
      } catch (e) {
        reject(e);
      }
    });

    toast.promise(promise, {
      loading: 'Saving configuration...',
      success: 'Configuration saved!',
      error: 'Invalid JSON in selectors. Please correct and try again.',
    });

    promise.finally(() => setIsSaving(false));
  };

  return (
    <Card className="bg-zinc-900 border-zinc-700 text-white">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="capitalize">{config.platform_id}</CardTitle>
        <div className="flex items-center space-x-2">
          <Checkbox id={`enabled-${config.platform_id}`} checked={isEnabled} onCheckedChange={(c) => setIsEnabled(c as boolean)} className="border-zinc-500" />
          <label htmlFor={`enabled-${config.platform_id}`} className="text-sm font-medium leading-none">Enabled</label>
        </div>
      </CardHeader>
      <CardContent>
        <Textarea value={selectors} onChange={e => setSelectors(e.target.value)} rows={12} className="w-full font-mono text-xs bg-zinc-800 border-zinc-600 rounded-md" />
      </CardContent>
      <CardFooter className="flex justify-between items-center">
        <Button onClick={handleSave} disabled={isSaving}>{isSaving ? 'Saving...' : 'Save'}</Button>
        <p className="text-xs text-zinc-400">
          Last updated: {new Date(config.last_updated_at).toLocaleString()} by {config.updated_by}
        </p>
      </CardFooter>
    </Card>
  );
}

// Bug Report Viewer
function BugReportViewer({ reports }: { reports: ScraperBugReport[] }) {
  return (
    <Card className="bg-zinc-900 border-zinc-700 text-white mt-8">
      <CardHeader>
        <CardTitle>Bug Reports ({reports.length})</CardTitle>
        <CardDescription>Automatically reported scraper issues from users.</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow className="border-zinc-700">
              <TableHead>Platform</TableHead>
              <TableHead>Error</TableHead>
              <TableHead>URL</TableHead>
              <TableHead>Snippet</TableHead>
              <TableHead className="text-right">Reported At</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {reports.map(report => (
              <TableRow key={report.id} className="border-zinc-800">
                <TableCell>{report.platform_id}</TableCell>
                <TableCell className="max-w-xs truncate">{report.error_message ?? '—'}</TableCell>
                <TableCell>{report.href ? <a href={report.href} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">Link</a> : '—'}</TableCell>
                <TableCell>
                  {report.dom_snippet && (
                    <Dialog>
                      <DialogTrigger asChild><Button variant="outline" size="sm">View</Button></DialogTrigger>
                      <DialogContent className="sm:max-w-[80vw] bg-zinc-900 border-zinc-700 text-white">
                        <DialogHeader><DialogTitle>DOM Snippet</DialogTitle></DialogHeader>
                        <pre className="mt-2 w-full rounded-md bg-zinc-950 p-4 overflow-auto max-h-[60vh]">
                          <code className="text-white text-xs" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(report.dom_snippet) }} />
                        </pre>
                        <DialogFooter><DialogClose asChild><Button type="button" variant="secondary">Close</Button></DialogClose></DialogFooter>
                      </DialogContent>
                    </Dialog>
                  )}
                </TableCell>
                <TableCell className="text-right text-xs">{new Date(report.created_at).toLocaleString()}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {reports.length === 0 && <p className="text-center text-zinc-400 py-8">No bug reports found.</p>}
      </CardContent>
    </Card>
  );
}

const PLATFORMS = ['claude','chatgpt','gemini','grok','deepseek','perplexity'];
const DEFAULT_SELECTORS = {
  claude:     { userSelector: "[data-testid='user-message']", assistantSelector: ".font-claude-response", rootSelector: "[class*='conversation']", inputSelector: "[contenteditable='true'][class*='ProseMirror']" },
  chatgpt:    { userSelector: "[data-message-author-role='user']", assistantSelector: "[data-message-author-role='assistant']", rootSelector: "main", inputSelector: "#prompt-textarea" },
  gemini:     { userSelector: "user-query", assistantSelector: "model-response", rootSelector: "chat-window-content", inputSelector: "rich-textarea" },
  grok:       { userSelector: "[data-testid='user-message']", assistantSelector: "[data-testid='assistant-message']", rootSelector: "main", inputSelector: "textarea" },
  deepseek:   { userSelector: "[class*='ds-message']", assistantSelector: "[class*='ds-assistant-message-main-content']", rootSelector: "[class*='chat-main']", inputSelector: "textarea" },
  perplexity: { userSelector: "[class*='group/query']", assistantSelector: "[class*='prose']", rootSelector: "[class*='thread']", inputSelector: "textarea" },
};

const supabase = createClient();

// Main Page Component
export default function ScraperAdminPage() {
  const [configs, setConfigs] = useState<PlatformConfig[]>([]);
  const [reports, setReports] = useState<ScraperBugReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reportsError, setReportsError] = useState<string | null>(null);

  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true);
        const { data: { session } } = await supabase.auth.getSession();
        const token = session?.access_token ?? '';
        const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

        const [configsRes, reportsRes] = await Promise.all([
          fetch('/api/scraper-admin/configs', { headers }),
          fetch('/api/scraper-admin/bug-reports', { headers }),
        ]);

        if (!configsRes.ok) throw new Error(`Failed to fetch configs: ${await configsRes.text()}`);
        let configsData: PlatformConfig[] = await configsRes.json();

        // If no configs in DB yet, seed defaults so the editor is usable immediately
        if (!Array.isArray(configsData) || configsData.length === 0) {
          configsData = PLATFORMS.map(p => ({
            platform_id: p,
            is_enabled: true,
            selectors: DEFAULT_SELECTORS[p as keyof typeof DEFAULT_SELECTORS] ?? {},
            last_updated_at: new Date().toISOString(),
            updated_by: 'default',
          }));
        }
        setConfigs(configsData);

        if (reportsRes.ok) {
          const reportsData = await reportsRes.json();
          setReports(Array.isArray(reportsData) ? reportsData : []);
          setReportsError(null);
        } else {
          const errText = await reportsRes.text().catch(() => '');
          setReportsError(`${reportsRes.status}: ${errText.slice(0, 200)}`);
          console.warn(`Could not fetch bug reports: ${reportsRes.status}`, errText);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'An unknown error occurred';
        setError(msg);
        toast.error(msg);
      } finally {
        setLoading(false);
      }
    };
    void fetchData();
  }, []);

  const handleSaveConfig = async (configToSave: PlatformConfig) => {
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token ?? '';
    const res = await fetch('/api/scraper-admin/configs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(configToSave),
    });
    if (!res.ok) {
      throw new Error('Failed to save config');
    } else {
      const newConfigs = configs.map(c => c.platform_id === configToSave.platform_id ? configToSave : c);
      setConfigs(newConfigs);
    }
  };

  if (loading) return <div className="flex items-center justify-center h-screen bg-black text-white">Loading...</div>;
  if (error) return <div className="flex items-center justify-center h-screen bg-black text-white">Error: {error}</div>;

  return (
    <div className="min-h-screen bg-black text-white p-4 sm:p-6 lg:p-8">
      <Toaster richColors theme="dark" />
      <header className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight">Scraper Admin</h1>
        <p className="text-zinc-400">Manage platform selectors and view bug reports.</p>
      </header>
      
      <section>
        <h2 className="text-2xl font-semibold mb-4">Platform Configurations</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
          {configs.map(config => (
            <PlatformEditor key={config.platform_id} config={config} onSave={handleSaveConfig} />
          ))}
        </div>
      </section>

      <section>
        {reportsError && (
          <div className="mb-4 p-3 rounded border border-red-500/30 bg-red-500/5 text-red-400 text-xs font-mono">
            ⚠ Bug reports fetch failed: {reportsError}
          </div>
        )}
        <BugReportViewer reports={reports} />
      </section>
    </div>
  );
}
