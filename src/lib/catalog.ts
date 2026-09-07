/**
 * Projects and tags: the two catalogues tasks are filed under.
 *
 * They get one module because they pose the same problem. Both are referenced
 * by tasks, both can be renamed and recoloured, and both raise the awkward
 * question of what happens to the references when one goes away. The answer
 * this app gives is: *archive* by default, so a task completed last month still
 * resolves the name it was filed under, and if you insist on deleting, say
 * explicitly what should happen to the tasks — with the counts in front of you.
 *
 * Pure, like everything in lib/. Ids arrive as arguments because minting them
 * is the store's job.
 */
import { err, ok } from './types.ts'
import type { Project, Result, State, Tag, Task } from './types.ts'

/** Token names resolved to real colours in the stylesheet. */
export const CATALOG_COLORS = ['teal', 'indigo', 'amber', 'plum', 'moss', 'clay'] as const

export type CatalogErrorCode =
  | 'not-found'
  | 'blank-name'
  | 'duplicate-name'
  | 'target-not-found'
  | 'target-is-self'

export type CatalogError = { code: CatalogErrorCode; message: string }

const fail = (code: CatalogErrorCode, message: string): Result<never, CatalogError> =>
  err({ code, message })

/**
 * How many tasks reference a catalogue entry.
 *
 * Only top-level tasks are counted, because a subtask is never filed anywhere
 * of its own accord — it belongs to its parent's row and nothing else. Open and
 * completed are counted separately: completed tasks are the whole reason
 * archiving exists, so a confirmation that hid them would be arguing against
 * its own advice.
 */
export type Usage = { open: number; done: number; total: number }

function usage(tasks: readonly Task[], matches: (t: Task) => boolean): Usage {
  let open = 0
  let done = 0
  for (const t of tasks) {
    if (t.parentId !== null || !matches(t)) continue
    if (t.done) done += 1
    else open += 1
  }
  return { open, done, total: open + done }
}

export function projectUsage(state: State, id: string): Usage {
  return usage(state.tasks, (t) => t.projectId === id)
}

export function tagUsage(state: State, id: string): Usage {
  return usage(state.tasks, (t) => t.tagIds.includes(id))
}

const clean = (name: string): string => name.trim().replace(/\s+/g, ' ')

function nameTaken(
  existing: readonly { id: string; name: string }[],
  name: string,
  exceptId?: string,
): boolean {
  const lower = name.toLowerCase()
  return existing.some((e) => e.id !== exceptId && e.name.toLowerCase() === lower)
}

/** The next colour in the ring, so a fresh catalogue does not come out all one shade. */
export function nextColor(count: number): string {
  return CATALOG_COLORS[count % CATALOG_COLORS.length]!
}

// ---- projects -------------------------------------------------------------

export function createProject(
  state: State,
  id: string,
  name: string,
  colorToken: string = nextColor(state.projects.length),
): Result<{ state: State; project: Project }, CatalogError> {
  const trimmed = clean(name)
  if (trimmed === '') return fail('blank-name', 'a project needs a name')
  if (nameTaken(state.projects, trimmed)) {
    return fail('duplicate-name', `there is already a project called ${trimmed}`)
  }

  const project: Project = {
    id,
    name: trimmed,
    colorToken,
    icon: 'circle',
    archived: false,
    order: state.projects.length,
  }
  return ok({ state: { ...state, projects: [...state.projects, project] }, project })
}

function patchProject(state: State, id: string, patch: Partial<Project>): Result<State, CatalogError> {
  if (!state.projects.some((p) => p.id === id)) return fail('not-found', `no project ${id}`)
  return ok({
    ...state,
    projects: state.projects.map((p) => (p.id === id ? { ...p, ...patch } : p)),
  })
}

export function renameProject(state: State, id: string, name: string): Result<State, CatalogError> {
  const trimmed = clean(name)
  if (trimmed === '') return fail('blank-name', 'a project needs a name')
  if (nameTaken(state.projects, trimmed, id)) {
    return fail('duplicate-name', `there is already a project called ${trimmed}`)
  }
  return patchProject(state, id, { name: trimmed })
}

export function setProjectColor(
  state: State,
  id: string,
  colorToken: string,
): Result<State, CatalogError> {
  return patchProject(state, id, { colorToken })
}

/**
 * Archive: the default way to retire a project.
 *
 * Nothing is rewritten, so the tasks keep pointing at it and a completed task
 * from last month still resolves the name it was filed under. It simply stops
 * appearing in the sidebar and in the pickers.
 */
export function setProjectArchived(
  state: State,
  id: string,
  archived: boolean,
): Result<State, CatalogError> {
  return patchProject(state, id, { archived })
}

/**
 * What happens to the tasks when a project is deleted outright. There is no
 * default, because this is precisely the decision the user has to make out loud.
 */
export type ProjectDisposition = { tasks: 'reassign'; to: string | null } | { tasks: 'delete' }

export function deleteProject(
  state: State,
  id: string,
  disposition: ProjectDisposition,
): Result<State, CatalogError> {
  if (!state.projects.some((p) => p.id === id)) return fail('not-found', `no project ${id}`)

  const projects = state.projects.filter((p) => p.id !== id)

  if (disposition.tasks === 'delete') {
    const doomed = new Set(
      state.tasks.filter((t) => t.parentId === null && t.projectId === id).map((t) => t.id),
    )
    // Subtasks go with their parent. They are checklist items on a task that no
    // longer exists; leaving them orphaned would be worse than either answer
    // the user was actually offered.
    const tasks = state.tasks.filter(
      (t) => !doomed.has(t.id) && !(t.parentId !== null && doomed.has(t.parentId)),
    )
    return ok({ ...state, projects, tasks })
  }

  const to = disposition.to
  if (to !== null) {
    if (to === id) return fail('target-is-self', 'cannot reassign a project to itself')
    if (!state.projects.some((p) => p.id === to)) return fail('target-not-found', `no project ${to}`)
  }

  const tasks = state.tasks.map((t) => (t.projectId === id ? { ...t, projectId: to } : t))
  return ok({ ...state, projects, tasks })
}

// ---- tags -----------------------------------------------------------------

export function createTag(
  state: State,
  id: string,
  name: string,
  colorToken: string = nextColor(state.tags.length),
): Result<{ state: State; tag: Tag }, CatalogError> {
  const trimmed = clean(name)
  if (trimmed === '') return fail('blank-name', 'a tag needs a name')
  if (nameTaken(state.tags, trimmed)) {
    return fail('duplicate-name', `there is already a tag called ${trimmed}`)
  }

  const tag: Tag = { id, name: trimmed, colorToken, archived: false }
  return ok({ state: { ...state, tags: [...state.tags, tag] }, tag })
}

function patchTag(state: State, id: string, patch: Partial<Tag>): Result<State, CatalogError> {
  if (!state.tags.some((t) => t.id === id)) return fail('not-found', `no tag ${id}`)
  return ok({ ...state, tags: state.tags.map((t) => (t.id === id ? { ...t, ...patch } : t)) })
}

export function renameTag(state: State, id: string, name: string): Result<State, CatalogError> {
  const trimmed = clean(name)
  if (trimmed === '') return fail('blank-name', 'a tag needs a name')
  if (nameTaken(state.tags, trimmed, id)) {
    return fail('duplicate-name', `there is already a tag called ${trimmed}`)
  }
  return patchTag(state, id, { name: trimmed })
}

export function setTagColor(state: State, id: string, colorToken: string): Result<State, CatalogError> {
  return patchTag(state, id, { colorToken })
}

export function setTagArchived(state: State, id: string, archived: boolean): Result<State, CatalogError> {
  return patchTag(state, id, { archived })
}

/**
 * A tag's deletion offers *untag* where a project's offers *delete the tasks*.
 *
 * The choice is the same shape — reassign the references, or get rid of them —
 * but the reference here is one chip among several, not the file the task lives
 * in. Destroying a task because you retired one of its labels would be a
 * disproportionate answer to the question being asked.
 */
export type TagDisposition = { tasks: 'reassign'; to: string } | { tasks: 'untag' }

export function deleteTag(
  state: State,
  id: string,
  disposition: TagDisposition,
): Result<State, CatalogError> {
  if (!state.tags.some((t) => t.id === id)) return fail('not-found', `no tag ${id}`)

  if (disposition.tasks === 'reassign') {
    const to = disposition.to
    if (to === id) return fail('target-is-self', 'cannot reassign a tag to itself')
    if (!state.tags.some((t) => t.id === to)) return fail('target-not-found', `no tag ${to}`)
  }

  const tags = state.tags.filter((t) => t.id !== id)
  const tasks = state.tasks.map((t) => {
    if (!t.tagIds.includes(id)) return t
    const next =
      disposition.tasks === 'untag'
        ? t.tagIds.filter((x) => x !== id)
        : // De-duplicate: a task carrying both the retired tag and its
          // destination must not come out of this holding the same tag twice.
          [...new Set(t.tagIds.map((x) => (x === id ? disposition.to : x)))]
    return { ...t, tagIds: next }
  })

  return ok({ ...state, tags, tasks })
}
