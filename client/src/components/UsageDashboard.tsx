import React, { useEffect, useState } from 'react';
import { systemAPI } from '../services/api';
import { BarChart3, TrendingUp, FileText, Users, DollarSign, RefreshCw } from 'lucide-react';

interface DailyRow { day: string; prompt_tokens: number; completion_tokens: number; submissions: number; provider: string; }
interface DocTypeRow { doc_type: string; prompt_tokens: number; completion_tokens: number; submissions: number; }
interface UserRow { name: string; email: string; prompt_tokens: number; completion_tokens: number; submissions: number; }
interface Totals { prompt_tokens: number; completion_tokens: number; submissions: number; estimated_cost_usd: number; }
interface UsageData { days: number; totals: Totals; daily: DailyRow[]; byDocType: DocTypeRow[]; topUsers: UserRow[]; }

const fmt = (n: number) => n.toLocaleString();
const fmtCost = (n: number) => `$${n.toFixed(2)}`;

const StatCard: React.FC<{ icon: React.ReactNode; label: string; value: string; sub?: string; accent?: string }> =
  ({ icon, label, value, sub, accent = 'text-primary-600 bg-primary-50' }) => (
  <div className="rounded-xl border border-slate-200 bg-white p-5">
    <div className={`mb-3 inline-flex h-10 w-10 items-center justify-center rounded-lg ${accent}`}>{icon}</div>
    <div className="text-2xl font-bold text-slate-800">{value}</div>
    <div className="text-sm font-medium text-slate-600">{label}</div>
    {sub && <div className="mt-0.5 text-xs text-slate-400">{sub}</div>}
  </div>
);

const UsageDashboard: React.FC = () => {
  const [data, setData] = useState<UsageData | null>(null);
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async (d: number) => {
    setLoading(true);
    setError(null);
    try {
      const result = await systemAPI.getUsage(d);
      setData(result);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to load usage data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(days); }, [days]);

  const maxTokens = data ? Math.max(...data.daily.map(r => Number(r.prompt_tokens) + Number(r.completion_tokens)), 1) : 1;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-slate-800">AI Token Usage</h3>
          <p className="text-sm text-slate-500">Cost visibility across all marking jobs</p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={days}
            onChange={e => setDays(Number(e.target.value))}
            className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-primary-500"
          >
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
          <button
            onClick={() => load(days)}
            disabled={loading}
            className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 border border-red-100 p-4 text-sm text-red-700">{error}</div>
      )}

      {data && (
        <>
          {/* Stat cards */}
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatCard
              icon={<BarChart3 className="h-5 w-5" />}
              label="Total submissions"
              value={fmt(data.totals.submissions)}
              sub={`last ${days} days`}
            />
            <StatCard
              icon={<TrendingUp className="h-5 w-5" />}
              label="Prompt tokens"
              value={fmt(data.totals.prompt_tokens)}
              accent="text-primary-600 bg-primary-50"
            />
            <StatCard
              icon={<FileText className="h-5 w-5" />}
              label="Completion tokens"
              value={fmt(data.totals.completion_tokens)}
              accent="text-violet-600 bg-violet-50"
            />
            <StatCard
              icon={<DollarSign className="h-5 w-5" />}
              label="Est. API cost"
              value={fmtCost(data.totals.estimated_cost_usd)}
              sub="GPT-4o pricing baseline"
              accent="text-emerald-600 bg-emerald-50"
            />
          </div>

          {/* Daily chart */}
          {data.daily.length > 0 && (
            <div className="rounded-xl border border-slate-200 bg-white p-5">
              <h4 className="mb-4 text-sm font-semibold text-slate-700">Daily token usage</h4>
              <div className="flex items-end gap-1 overflow-x-auto pb-2" style={{ minHeight: 100 }}>
                {[...data.daily].reverse().map((row, i) => {
                  const total = Number(row.prompt_tokens) + Number(row.completion_tokens);
                  const h = Math.max(4, Math.round((total / maxTokens) * 88));
                  return (
                    <div key={i} className="group relative flex flex-col items-center gap-1" style={{ minWidth: 20 }}>
                      <div
                        className="w-5 rounded-t bg-primary-500 transition-all group-hover:bg-primary-600"
                        style={{ height: h }}
                        title={`${row.day}\n${fmt(total)} tokens\n${row.submissions} submissions`}
                      />
                      {i % 5 === 0 && (
                        <span className="text-[10px] text-slate-400 rotate-45 origin-left whitespace-nowrap">
                          {row.day?.slice(5)}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            {/* By doc type */}
            {data.byDocType.length > 0 && (
              <div className="rounded-xl border border-slate-200 bg-white p-5">
                <h4 className="mb-4 text-sm font-semibold text-slate-700">Usage by document type</h4>
                <div className="space-y-3">
                  {data.byDocType.map((row, i) => {
                    const total = Number(row.prompt_tokens) + Number(row.completion_tokens);
                    const maxTotal = Math.max(...data.byDocType.map(r => Number(r.prompt_tokens) + Number(r.completion_tokens)), 1);
                    const pct = Math.round((total / maxTotal) * 100);
                    return (
                      <div key={i}>
                        <div className="mb-1 flex justify-between text-xs text-slate-600">
                          <span className="font-medium capitalize">{row.doc_type}</span>
                          <span>{fmt(row.submissions)} jobs · {fmt(total)} tokens</span>
                        </div>
                        <div className="h-2 rounded-full bg-slate-100">
                          <div className="h-2 rounded-full bg-primary-400" style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Top users */}
            {data.topUsers.length > 0 && (
              <div className="rounded-xl border border-slate-200 bg-white p-5">
                <h4 className="mb-4 text-sm font-semibold text-slate-700 flex items-center gap-2">
                  <Users className="h-4 w-4" />Top consumers
                </h4>
                <div className="space-y-3">
                  {data.topUsers.map((u, i) => {
                    const total = Number(u.prompt_tokens) + Number(u.completion_tokens);
                    const maxTotal = Math.max(...data.topUsers.map(r => Number(r.prompt_tokens) + Number(r.completion_tokens)), 1);
                    const pct = Math.round((total / maxTotal) * 100);
                    return (
                      <div key={i}>
                        <div className="mb-1 flex justify-between text-xs text-slate-600">
                          <span className="font-medium">{u.name || u.email}</span>
                          <span>{fmt(u.submissions)} jobs · {fmt(total)} tokens</span>
                        </div>
                        <div className="h-2 rounded-full bg-slate-100">
                          <div className="h-2 rounded-full bg-violet-400" style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {data.totals.submissions === 0 && !loading && (
            <div className="rounded-xl border-2 border-dashed border-slate-200 p-10 text-center">
              <BarChart3 className="mx-auto h-10 w-10 text-slate-300" />
              <p className="mt-3 text-sm text-slate-500">No marking jobs in the last {days} days.</p>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default UsageDashboard;
