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
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AdvancedSection } from '@/pages/settings/AdvancedSection';
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

let downloadProgress: Record<string, unknown> = {};
let settingsGet: () => unknown = () => modelSettings;
let unmocked: string[] = [];

const responses: Record<string, () => unknown> = {
  [SETTINGS]: () => settingsGet(),
  [TIERS]: () => tiers,
  [PROGRESS]: () => downloadProgress,
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
