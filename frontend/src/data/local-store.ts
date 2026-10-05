import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'field-archaeology-digital:entries'
// 老版本浏览器数据没有乐观锁版本号，schema 一变就整体回种，保证每条记录都带版本。
const SCHEMA_KEY = 'field-archaeology-digital:schema'
const SCHEMA_VERSION = 2
const INITIAL_VERSION = 1

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** 给历史数据补齐乐观锁版本：没有版本的记录一律视为第 1 版。 */
function withVersion(row: EntryRow): EntryRow {
  return typeof row.version === 'number' ? row : { ...row, version: INITIAL_VERSION }
}

function normalize(records: Record<string, EntryRow[]>): Record<string, EntryRow[]> {
  const next: Record<string, EntryRow[]> = {}
  for (const [key, rows] of Object.entries(records)) {
    next[key] = Array.isArray(rows) ? rows.map(withVersion) : []
  }
  return next
}

function seedData(): Record<string, EntryRow[]> {
  return normalize(clone(SEED_ROWS))
}

function schemaChanged(): boolean {
  if (typeof window === 'undefined' || !window.localStorage) {
    return false
  }
  return window.localStorage.getItem(SCHEMA_KEY) !== String(SCHEMA_VERSION)
}

function markSchema(): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(SCHEMA_KEY, String(SCHEMA_VERSION))
  }
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = seedData()
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  if (schemaChanged()) {
    // 结构升级：旧数据没有版本号，直接回种示例数据，避免历史脏数据绕过乐观锁。
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    markSchema()
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    markSchema()
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return normalize({ ...fallback, ...parsed })
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    markSchema()
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

/**
 * 绕开内存缓存直接读 localStorage：两个终端（标签页）同时校核时，
 * 后到的一端必须以对方刚刚落库的最新数据为准做版本比对，不能用过了期的缓存。
 */
export function freshRows(): Record<string, EntryRow[]> {
  const records = readStorage()
  cache = records
  return records
}

export function saveRows(key: string, rows: EntryRow[]): void {
  commitRows({ [key]: rows })
}

/**
 * 多模块一次性原子落库。批量校核成功后，三维坐标的状态/校核人/高程
 * 与考古调查模块的现场复测清单必须同生共死：要么全部写进去，要么一个都不写。
 */
export function commitRows(patch: Record<string, EntryRow[]>): void {
  const next = { ...freshRows(), ...clone(patch) }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? []).map(withVersion)
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
