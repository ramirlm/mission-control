/**
 * Tests for the admin user seed behavior in db.ts.
 * Verifies that weak/missing AUTH_PASS is handled safely.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Hoisted mock factories so they are available inside vi.mock() factories
const { mockRun, mockGet, mockPrepare, mockLogger } = vi.hoisted(() => {
  const mockRun = vi.fn(() => ({ lastInsertRowid: 1, changes: 1 }))
  const mockGet = vi.fn((): any => ({ count: 0 })) // no users — triggers seeding
  const mockPrepare = vi.fn(() => ({
    run: mockRun,
    get: mockGet,
    all: vi.fn(() => []),
  }))
  const mockLogger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }
  return { mockRun, mockGet, mockPrepare, mockLogger }
})

vi.mock('better-sqlite3', () => ({
  default: vi.fn(() => ({
    prepare: mockPrepare,
    pragma: vi.fn(),
    exec: vi.fn(),
    close: vi.fn(),
    backup: vi.fn(),
  })),
}))

vi.mock('@/lib/config', () => ({
  config: { dbPath: ':memory:', retention: {} },
  ensureDirExists: vi.fn(),
}))

vi.mock('@/lib/migrations', () => ({
  runMigrations: vi.fn(),
}))

vi.mock('@/lib/password', () => ({
  hashPassword: vi.fn((p: string) => `hashed:${p}`),
  verifyPassword: vi.fn(() => false),
}))

vi.mock('@/lib/logger', () => ({
  logger: mockLogger,
}))

vi.mock('@/lib/event-bus', () => ({
  eventBus: { broadcast: vi.fn(), on: vi.fn(), emit: vi.fn(), setMaxListeners: vi.fn() },
}))

// Stub optional lazy imports (webhooks, scheduler) to prevent side-effects
vi.mock('@/lib/webhooks', () => ({ initWebhookListener: vi.fn() }))
vi.mock('@/lib/scheduler', () => ({ initScheduler: vi.fn() }))

describe('seedAdminUserFromEnv', () => {
  const originalEnv = process.env

  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    process.env = { ...originalEnv }
    delete process.env.NEXT_PHASE
    delete process.env.AUTH_PASS
    delete process.env.AUTH_USER
    // Simulate empty users table so seeding runs
    mockGet.mockReturnValue({ count: 0 })
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('generates a random password and logs a warning when AUTH_PASS is not set', async () => {
    delete process.env.AUTH_PASS
    const { getDatabase } = await import('@/lib/db')
    getDatabase()

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('AUTH_PASS is not set')
    )
    // A user INSERT should still happen
    expect(mockRun).toHaveBeenCalled()
  })

  it('skips seeding and logs an error when AUTH_PASS is too short', async () => {
    process.env.AUTH_PASS = 'short'
    const { getDatabase } = await import('@/lib/db')
    getDatabase()

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('AUTH_PASS must be at least')
    )
    // INSERT for user should NOT have been called
    const prepareSqls = mockPrepare.mock.calls.map((c) => c[0] as string)
    const hasUserInsert = prepareSqls.some(
      (sql) => sql?.includes('INSERT OR IGNORE INTO users')
    )
    expect(hasUserInsert).toBe(false)
  })

  it('seeds normally when AUTH_PASS meets the minimum length', async () => {
    process.env.AUTH_PASS = 'secure-password-123'
    const { getDatabase } = await import('@/lib/db')
    getDatabase()

    // Should not warn about missing password
    expect(mockLogger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('AUTH_PASS is not set')
    )
    // Should not error about short password
    expect(mockLogger.error).not.toHaveBeenCalledWith(
      expect.stringContaining('AUTH_PASS must be at least')
    )
    // INSERT should be called
    expect(mockRun).toHaveBeenCalled()
  })

  it('skips seeding entirely during next build phase', async () => {
    process.env.NEXT_PHASE = 'phase-production-build'
    process.env.AUTH_PASS = 'some-password-123'
    const { getDatabase } = await import('@/lib/db')
    getDatabase()

    // No user INSERT should happen during build
    const prepareSqls = mockPrepare.mock.calls.map((c) => c[0] as string)
    const hasUserInsert = prepareSqls.some(
      (sql) => sql?.includes('INSERT OR IGNORE INTO users')
    )
    expect(hasUserInsert).toBe(false)
  })

  it('skips seeding when users already exist', async () => {
    mockGet.mockReturnValue({ count: 3 })
    process.env.AUTH_PASS = 'valid-password-123'
    const { getDatabase } = await import('@/lib/db')
    getDatabase()

    // No warning or error expected
    expect(mockLogger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('AUTH_PASS is not set')
    )
    expect(mockLogger.error).not.toHaveBeenCalledWith(
      expect.stringContaining('AUTH_PASS must be at least')
    )
  })
})
