/**
 * SETTINGS-OCR-429, SETTINGS-TIER-SPINNER, SETTINGS-POLL-IDLE (owner Windows run, 2026-11-22).
 *
 *   HC-SETFIX-001..003  a refetch that fails (a 429 from the per-IP limiter) keeps the panel, and an OCR toggle writes the
 *                       PATCH answer into the cache instead of asking for six reads again
 *   HC-SETFIX-010..013  one Download button spins (the tier that is downloading), the rest stay disabled and still, and the
 *                       progress bar names the model
 *   HC-SETFIX-020..024  the download progress is polled only while a download is active, and picked up again on mount and
 *                       after a Download press
 *
 * AdvancedSection is rendered with the real hooks and the real cards against a routed `apiGet` mock. The HC-UISET-011 and
 * HC-UISET-019 tests in ui-settings.test.tsx are the other half of the download rules and are not edited.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { AdvancedSection } from '@/pages/settings/AdvancedSection';
import { useDownloadProgress, useStartDownload } from '@/services/modelSettings';
import { useAuthStore } from '@/stores/authStore';
import * as api from '@/services/api';

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return {
    ...actual,
    apiGet: vi.fn(),
    apiPost: vi.fn(),
    apiPut: vi.fn(),
    apiPatch: vi.fn(),
    apiDelete: vi.fn(),
  };
});

const GB = 1_073_741_824;
const SETTINGS = '/settings/model';
const TIERS = '/settings/model/tiers';
const PROGRESS = '/settings/model/download-progress';
const EXTERNAL = '/settings/model/external-api';
const DIAGNOSTICS = '/settings/model/diagnostics';

const modelSettings = {
  current_tier: 'mid',
  preferred_tier: 'low',
  recommended_tier: 'mid',
  auto_detect_enabled: false,
  hardware_info: {
    ram_total_gb: 16, ram_available_gb: 8, cpu_cores: 8, cpu_name: 'Test CPU', disk_free_gb: 100,
    gpu_available: true, gpu_vram_gb: 8, gpu_name: 'Test GPU', recommended_tier: 'mid', max_supported_tier: 'mid',
    detection_timestamp: '2026-11-22T08:00:00Z',
  },
  tier_availability: {},
  ocr_preference_enabled: false,
  ocr_effective: false,
  ocr_blockers: ['user_disabled'],
  agent_enabled: true,
};

const caps = { context_size: 2048, multimodal: false, function_calling: false, agentic_capable: false };
const tierRow = (tier: string, name: string, downloaded: boolean, can_run: boolean) => ({
  tier, name, model: null, description: `${name} description`, available: downloaded, downloaded,
  requirements: { ram_gb: 8, disk_gb: 1 }, can_run, capabilities: caps,
});
const tiers = {
  recommended_tier: 'mid',
  tiers: [
    tierRow('low', 'Tier 1: Low', true, true),
    tierRow('mid', 'Tier 2: Mid', false, true),
    tierRow('high', 'Tier 3: High', false, true),
    tierRow('gemma4-e2b', 'Template Mode', false, true),
  ],
};

const entry = (tier: string, status: string, progress: number) => ({
  tier, status, progress, downloaded_bytes: progress * GB, total_bytes: GB, path: null, error: null,
});

let downloadProgress: Record<string, unknown> = {};
let settingsGet: () => unknown = () => modelSettings;
// The next N reads of the progress fail, as a 429 from the per-IP limiter does.
let progressFailures = 0;
let unmocked: string[] = [];

const responses: Record<string, () => unknown> = {
  [SETTINGS]: () => settingsGet(),
  [TIERS]: () => tiers,
  [PROGRESS]: () => {
    if (progressFailures > 0) {
      progressFailures -= 1;
      throw new Error('Rate limit exceeded');
    }
    return downloadProgress;
  },
  [EXTERNAL]: () => ({ use_external_api: false, provider: '', model: '', api_key_configured: false, redaction_break_glass: false }),
  [DIAGNOSTICS]: () => ({ checked_at: '2026-11-22T08:00:00Z', components: [] }),
  '/feedback/stats': () => ({
    total_feedback: 0, positive_count: 0, negative_count: 0, correction_count: 0,
    tag_distribution: {}, model_distribution: {}, provider_distribution: {},
  }),
  '/memory/': () => [],
  '/donation/consents': () => ({ consents: [] }),
  '/profiles/': () => [{ id: 'p1', has_recovery_code: true }],
};

const getCalls = (path: string) => vi.mocked(api.apiGet).mock.calls.filter(([p]) => p === path).length;

// The app's client keeps every read fresh for 5 minutes and retries once; retry is off here so that a failure lands at once.
function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 5 * 60_000 }, mutations: { retry: false } } });
}

function renderAdvanced() {
  const client = makeClient();
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AdvancedSection exportResult={null} onExportResult={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>
  );
  return { client, user };
}

async function openAdvanced(user: ReturnType<typeof userEvent.setup>) {
  // The cards mount in staged commits (HC-UISET-023); a loaded machine needs longer than findBy's 1 s default.
  await user.click(await screen.findByRole('button', { name: 'Show advanced settings' }, { timeout: 5000 }));
  await screen.findByTestId('tier-row-low', {}, { timeout: 5000 });
  await screen.findByRole('button', { name: 'Export training data' }, { timeout: 5000 });
}

beforeEach(() => {
  vi.clearAllMocks();
  unmocked = [];
  downloadProgress = {};
  settingsGet = () => modelSettings;
  progressFailures = 0;
  useAuthStore.setState({ profileId: 'p1' } as never);
  vi.mocked(api.apiGet).mockImplementation(async (path: string) => {
    const respond = responses[path];
    if (!respond) {
      unmocked.push(path);
      throw new Error(`unmocked GET ${path}`);
    }
    return respond() as never;
  });
  vi.mocked(api.apiPut).mockResolvedValue({} as never);
  vi.mocked(api.apiPatch).mockResolvedValue({} as never);
  vi.mocked(api.apiPost).mockResolvedValue({} as never);
});

afterEach(() => {
  expect(unmocked, 'every GET the page made was answered').toEqual([]);
});

describe('SETTINGS-OCR-429: a failed refetch keeps the panel, and an OCR toggle does not re-ask for the settings', () => {
  it('HC-SETFIX-001: a refetch of the settings that fails with a 429 leaves the panel and the tier rows on screen', async () => {
    const { client, user } = renderAdvanced();
    await openAdvanced(user);

    settingsGet = () => {
      throw new Error('Rate limit exceeded');
    };
    await act(async () => {
      await client.refetchQueries({ queryKey: ['model-settings'], exact: true });
    });
    await waitFor(() => expect(client.getQueryState(['model-settings'])?.status).toBe('error'));

    expect(screen.queryByText('Failed to load settings. Please try again.')).not.toBeInTheDocument();
    expect(screen.getByTestId('tier-row-mid')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Enable OCR for scans & images' })).toBeInTheDocument();
  });

  it('HC-SETFIX-002: a settings read that has never succeeded still says so (the initial failure is not hidden)', async () => {
    settingsGet = () => {
      throw new Error('model settings down');
    };
    const { user } = renderAdvanced();
    await user.click(await screen.findByRole('button', { name: 'Show advanced settings' }));
    expect(await screen.findByText('Failed to load settings. Please try again.')).toBeInTheDocument();
    expect(screen.queryByTestId('tier-row-low')).not.toBeInTheDocument();
  });

  it('HC-SETFIX-003: after an OCR toggle the settings, tiers and external API are not read again, and the card shows the PATCH answer', async () => {
    vi.mocked(api.apiPatch).mockResolvedValue({ ocr_preference_enabled: true, ocr_effective: true, ocr_blockers: [] } as never);
    const { user } = renderAdvanced();
    await openAdvanced(user);
    const before = { settings: getCalls(SETTINGS), tiers: getCalls(TIERS), external: getCalls(EXTERNAL), diagnostics: getCalls(DIAGNOSTICS) };

    await user.click(screen.getByRole('switch', { name: 'Enable OCR for scans & images' }));

    expect(await screen.findByText('OCR is active for this profile (built-in reader + server allow).')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Enable OCR for scans & images' })).toBeChecked();
    expect(api.apiPatch).toHaveBeenCalledWith('/settings/model/ocr', { ocr_preference_enabled: true });
    // The diagnostics list depends on the OCR state and is asked again, once. Nothing else is.
    await waitFor(() => expect(getCalls(DIAGNOSTICS)).toBe(before.diagnostics + 1));
    expect(getCalls(SETTINGS)).toBe(before.settings);
    expect(getCalls(TIERS)).toBe(before.tiers);
    expect(getCalls(EXTERNAL)).toBe(before.external);
  });
});

describe('SETTINGS-OCR-429 (review F3): a failed refresh says so, in a status region that is there from the start', () => {
  it('HC-SETFIX-004: the region is empty and silent until a refetch fails, then names it, and empties when a refetch succeeds', async () => {
    const { client, user } = renderAdvanced();
    await openAdvanced(user);
    const note = screen.getByTestId('advanced-refresh-note');
    expect(note).toHaveAttribute('role', 'status');
    expect(note).toBeEmptyDOMElement();

    settingsGet = () => {
      throw new Error('Rate limit exceeded');
    };
    await act(async () => {
      await client.refetchQueries({ queryKey: ['model-settings'], exact: true });
    });
    await waitFor(() => expect(note).toHaveTextContent("Couldn't refresh settings. Showing the last saved values."));
    // The same element, not a new one: a live region that is added with its text is not announced.
    expect(screen.getByTestId('advanced-refresh-note')).toBe(note);
    expect(screen.getByTestId('tier-row-mid')).toBeInTheDocument();

    settingsGet = () => modelSettings;
    await act(async () => {
      await client.refetchQueries({ queryKey: ['model-settings'], exact: true });
    });
    await waitFor(() => expect(note).toBeEmptyDOMElement());
  });
});

describe('SETTINGS-TIER-SPINNER: only the tier that is downloading spins, and the bar names it', () => {
  const downloadButton = (tier: string) => within(screen.getByTestId(`tier-row-${tier}`)).getByRole('button', { name: 'Download' });
  const spinner = (tier: string) => downloadButton(tier).querySelector('[class*="animate-spin"]');

  it('HC-SETFIX-010: with mid downloading, only the mid row spins; every Download button is disabled', async () => {
    downloadProgress = { mid: entry('mid', 'downloading', 0.4) };
    const { user } = renderAdvanced();
    await openAdvanced(user);
    await screen.findByText('40%');

    expect(spinner('mid')).not.toBeNull();
    expect(spinner('high')).toBeNull();
    expect(spinner('gemma4-e2b')).toBeNull();
    for (const tier of ['mid', 'high', 'gemma4-e2b']) expect(downloadButton(tier), tier).toBeDisabled();
  });

  it('HC-SETFIX-011: the rows that do not spin keep the stillness classes and the T0 word (G10)', async () => {
    downloadProgress = { mid: entry('mid', 'downloading', 0.4) };
    const { user } = renderAdvanced();
    await openAdvanced(user);
    await screen.findByText('40%');

    for (const tier of ['mid', 'high', 'gemma4-e2b']) {
      const button = downloadButton(tier);
      expect(button.className, tier).toContain('disabled:opacity-100');
      expect(button.className, tier).not.toMatch(/disabled:text-/);
      expect(button.className, tier).toContain('active:scale-100');
      expect(button.querySelector('[data-t0]'), tier).toHaveTextContent('Download');
    }
  });

  it('HC-SETFIX-012: the bar names the model by its label, and falls back to the key for a tier without one', async () => {
    downloadProgress = { mid: entry('mid', 'downloading', 0.4) };
    const { user, client } = renderAdvanced();
    await openAdvanced(user);
    expect(await screen.findByText('Downloading Mid (Phi-4-mini)…')).toBeInTheDocument();
    expect(screen.queryByText('Downloading mid…')).not.toBeInTheDocument();

    downloadProgress = { 'gemma4-e2b': entry('gemma4-e2b', 'downloading', 0.2) };
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['model-settings', 'download-progress'] });
    });
    expect(await screen.findByText('Downloading gemma4-e2b…')).toBeInTheDocument();
  });

  it('HC-SETFIX-013: between the press and the first progress answer, only the pressed row spins and every row is disabled', async () => {
    let release: (value: unknown) => void = () => {};
    vi.mocked(api.apiPost).mockImplementation(() => new Promise((resolve) => { release = resolve; }) as never);
    const { user } = renderAdvanced();
    await openAdvanced(user);

    await user.click(downloadButton('gemma4-e2b'));
    await waitFor(() => expect(spinner('gemma4-e2b')).not.toBeNull());
    expect(spinner('mid')).toBeNull();
    expect(spinner('high')).toBeNull();
    for (const tier of ['mid', 'high', 'gemma4-e2b']) expect(downloadButton(tier), tier).toBeDisabled();
    await act(async () => { release({}); });
  });
});

describe('SETTINGS-POLL-IDLE (review F1, page): a failed read right after a press keeps every Download disabled', () => {
  it('HC-SETFIX-026: the POST answer is kept when the one progress read after it fails (429), the poll goes on, and no second press is possible', async () => {
    vi.mocked(api.apiPost).mockResolvedValue(entry('mid', 'pending', 0) as never);
    const { user } = renderAdvanced();
    await openAdvanced(user);
    const buttons = () => ['mid', 'high', 'gemma4-e2b'].map((tier) => within(screen.getByTestId(`tier-row-${tier}`)).getByRole('button', { name: 'Download' }));
    const before = getCalls(PROGRESS);

    progressFailures = 1;
    downloadProgress = { mid: entry('mid', 'downloading', 0.4) };
    await user.click(buttons()[0]);
    await waitFor(() => expect(getCalls(PROGRESS)).toBe(before + 1));
    await waitFor(() => expect(progressFailures).toBe(0));
    // The read has failed; nothing says the download is not running.
    for (const button of buttons()) expect(button).toBeDisabled();

    // The next poll answers, and the bar shows.
    expect(await screen.findByText('40%', {}, { timeout: 6000 })).toBeInTheDocument();
    for (const button of buttons()) expect(button).toBeDisabled();
  }, 15000);
});

describe('SETTINGS-POLL-IDLE: the download progress is polled only while a download is active', () => {
  // The hooks alone, on fake timers: 2 s is the poll interval, so 10 s is five polls if it never stops. The client is the
  // app's (a read stays fresh for 5 minutes), because that is what a return to Advanced meets.
  const wrap = (client: QueryClient) => ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const useProgressAndStart = () => ({ progress: useDownloadProgress(true), start: useStartDownload() });
  const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('HC-SETFIX-020: with no download running it reads once and then does not poll', async () => {
    renderHook(useProgressAndStart, { wrapper: wrap(makeClient()) });
    await advance(0);
    expect(getCalls(PROGRESS)).toBe(1);
    await advance(10_000);
    expect(getCalls(PROGRESS)).toBe(1);
  });

  it('HC-SETFIX-021: while a download runs it polls every 2 s', async () => {
    downloadProgress = { mid: entry('mid', 'downloading', 0.2) };
    renderHook(useProgressAndStart, { wrapper: wrap(makeClient()) });
    await advance(0);
    expect(getCalls(PROGRESS)).toBe(1);
    await advance(6_000);
    expect(getCalls(PROGRESS)).toBe(4);
  });

  it('HC-SETFIX-022: a Download press while idle reads the progress once and then polls', async () => {
    const { result } = renderHook(useProgressAndStart, { wrapper: wrap(makeClient()) });
    await advance(10_000);
    expect(getCalls(PROGRESS)).toBe(1);

    downloadProgress = { mid: entry('mid', 'downloading', 0.1) };
    await act(async () => { await result.current.start.mutateAsync('mid'); });
    await advance(0);
    expect(getCalls(PROGRESS)).toBe(2);
    await advance(6_000);
    expect(getCalls(PROGRESS)).toBe(5);
  });

  it('HC-SETFIX-023: the polling stops once the download completes', async () => {
    downloadProgress = { mid: entry('mid', 'downloading', 0.9) };
    renderHook(useProgressAndStart, { wrapper: wrap(makeClient()) });
    await advance(0);
    downloadProgress = { mid: entry('mid', 'completed', 1) };
    await advance(2_000);
    const atCompletion = getCalls(PROGRESS);
    expect(atCompletion).toBe(2);
    await advance(10_000);
    expect(getCalls(PROGRESS)).toBe(atCompletion);
  });

  it('HC-SETFIX-024: a download started elsewhere while Advanced was closed is picked up on return, and then polled', async () => {
    const client = makeClient();
    const first = renderHook(useProgressAndStart, { wrapper: wrap(client) });
    await advance(0);
    expect(getCalls(PROGRESS)).toBe(1);
    first.unmount();

    // Another window starts a download. The cached answer (idle) is younger than the client's 5 minutes.
    downloadProgress = { mid: entry('mid', 'downloading', 0.3) };
    await advance(30_000);
    renderHook(useProgressAndStart, { wrapper: wrap(client) });
    await advance(0);
    expect(getCalls(PROGRESS)).toBe(2);
    await advance(4_000);
    expect(getCalls(PROGRESS)).toBe(4);
  });

  // HC-UISET-019 (ui-settings.test.tsx, not edited) is the page-level case: downloading, failed, completed.
  it('HC-SETFIX-025: a failed answer right after a running download is followed for a while, then dropped; a failed answer alone is not polled', async () => {
    downloadProgress = { mid: entry('mid', 'downloading', 0.6) };
    renderHook(useProgressAndStart, { wrapper: wrap(makeClient()) });
    await advance(0);
    downloadProgress = { mid: { ...entry('mid', 'failed', 0), error: 'The download stopped before it finished. Try again.' } };
    await advance(2_000);
    expect(getCalls(PROGRESS)).toBe(2);
    downloadProgress = { mid: entry('mid', 'completed', 1) };
    await advance(2_000);
    expect(getCalls(PROGRESS)).toBe(3);

    // A failed answer that nothing running came before: one read, no polling.
    vi.mocked(api.apiGet).mockClear();
    downloadProgress = { mid: { ...entry('mid', 'failed', 0), error: 'The download stopped before it finished. Try again.' } };
    renderHook(useProgressAndStart, { wrapper: wrap(makeClient()) });
    await advance(10_000);
    expect(getCalls(PROGRESS)).toBe(1);
  });

  it('HC-SETFIX-027: a press whose one progress read fails (429) is followed for a while: the poll goes on and finds the download', async () => {
    const { result } = renderHook(useProgressAndStart, { wrapper: wrap(makeClient()) });
    await advance(0);
    expect(getCalls(PROGRESS)).toBe(1);

    progressFailures = 1;
    downloadProgress = { mid: entry('mid', 'downloading', 0.1) };
    await act(async () => { await result.current.start.mutateAsync('mid'); });
    await advance(0);
    expect(getCalls(PROGRESS)).toBe(2);
    expect(result.current.progress.isError).toBe(true);
    await advance(2_000);
    expect(getCalls(PROGRESS)).toBe(3);
    await advance(2_000);
    expect(getCalls(PROGRESS)).toBe(4);
    expect(result.current.progress.data).toEqual(downloadProgress);
  });

  it('HC-SETFIX-028: the poll that follows a press is bounded: with nothing running it stops after about 30 s', async () => {
    const { result } = renderHook(useProgressAndStart, { wrapper: wrap(makeClient()) });
    await advance(0);
    await act(async () => { await result.current.start.mutateAsync('mid'); });
    await advance(40_000);
    const settled = getCalls(PROGRESS);
    expect(settled).toBeGreaterThan(3);
    await advance(20_000);
    expect(getCalls(PROGRESS)).toBe(settled);
  });

  it('HC-SETFIX-029: a failed tier held for longer than the 10 s grace is no longer polled', async () => {
    downloadProgress = { mid: entry('mid', 'downloading', 0.6) };
    renderHook(useProgressAndStart, { wrapper: wrap(makeClient()) });
    await advance(0);
    downloadProgress = { mid: { ...entry('mid', 'failed', 0), error: 'The download stopped before it finished. Try again.' } };
    await advance(2_000);
    expect(getCalls(PROGRESS)).toBe(2);
    await advance(12_000);
    const settled = getCalls(PROGRESS);
    expect(settled).toBeGreaterThan(2);
    await advance(20_000);
    expect(getCalls(PROGRESS)).toBe(settled);
  });

  it('HC-SETFIX-030: a download started in another tab shows when the user comes back to this one (window focus reads again)', async () => {
    renderHook(useProgressAndStart, { wrapper: wrap(makeClient()) });
    await advance(0);
    expect(getCalls(PROGRESS)).toBe(1);

    downloadProgress = { mid: entry('mid', 'downloading', 0.3) };
    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await advance(0);
    expect(getCalls(PROGRESS)).toBe(2);
    await act(async () => { focusManager.setFocused(undefined); });
  });
});
