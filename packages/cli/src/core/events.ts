/**
 * The event stream (BE-1665, spec A-4). `subscribe {topics, sinceSeq?}` then notifications
 * `event {topic, seq, data}`, with `seq` increasing per topic.
 *
 * | Topic                      | Who may subscribe                              |
 * | `cards`, `operations`      | view; a harness receives only its own           |
 * | `clients`                  | view                                            |
 * | `status`, `portfolio`      | both                                            |
 * | `feed:<bucket>`            | both                                            |
 * | `token:<chain>:<address>`  | both                                            |
 * | `quant`                    | view (S5 Q-3)                                   |
 * | `signals`                  | both: the "All" rows (S5 G-2)                   |
 * | `signals:mine`             | view: a `scope: "mine"` subscribe (S5 Q-I10)    |
 *
 * On reconnect a client subscribes again with `sinceSeq` per topic. Card and operation events
 * still held are replayed; otherwise, and for every market topic, the topic's snapshot is sent.
 */
import type { Role } from "./tokens"

export const REPLAY_BUFFER = 1000
const OWNED_TOPICS = new Set(["cards", "operations"])

export interface CoreEvent {
  topic: string
  seq: number
  data: unknown
  /** The client the event belongs to, for `cards` and `operations`. A harness sees only its own. */
  ownerClientId?: string
}

export interface Subscriber {
  clientId: string
  role: Role
  send(notification: { jsonrpc: "2.0"; method: "event"; params: Record<string, unknown> }): void
}

export type SnapshotProvider = (subscriber: Subscriber) => unknown

/** Whether `topic` is a topic this core knows, and whether `role` may subscribe to it. */
export function topicAllowed(topic: string, role: Role): { known: boolean; allowed: boolean } {
  if (topic === "cards" || topic === "operations") return { known: true, allowed: true }
  if (topic === "clients") return { known: true, allowed: role === "view" }
  if (topic === "status" || topic === "portfolio") return { known: true, allowed: true }
  if (/^feed:[a-z]{1,32}$/.test(topic)) return { known: true, allowed: true }
  if (/^token:[a-z0-9]{1,16}:[A-Za-z0-9]{20,64}$/.test(topic)) return { known: true, allowed: true }
  // S5 (BE-1737): Quant is view only (Q-I2); a harness reads the "All" tape, never the watchlist (Q-I10).
  if (topic === "quant" || topic === "signals:mine") return { known: true, allowed: role === "view" }
  if (topic === "signals") return { known: true, allowed: true }
  return { known: false, allowed: false }
}

export class EventHub {
  private readonly seqs = new Map<string, number>()
  private readonly buffers = new Map<string, CoreEvent[]>()
  private readonly subscriptions = new Map<string, { subscriber: Subscriber; topics: Set<string> }>()
  private readonly snapshots = new Map<string, SnapshotProvider>()
  private readonly changeListeners: (() => void)[] = []

  /** Called after any subscription is added or removed, for a source that opens on demand (S5 G-1). */
  onSubscriptionsChanged(listener: () => void): void {
    this.changeListeners.push(listener)
  }

  /** How many clients are subscribed to `topic` now. */
  subscriberCount(topic: string): number {
    let n = 0
    for (const { topics } of this.subscriptions.values()) if (topics.has(topic)) n++
    return n
  }

  private changed(): void {
    for (const listener of this.changeListeners) listener()
  }

  /** Registers the snapshot for a topic, or for every topic with a prefix (`feed:`). */
  provideSnapshot(topicOrPrefix: string, provider: SnapshotProvider): void {
    this.snapshots.set(topicOrPrefix, provider)
  }

  publish(topic: string, data: unknown, ownerClientId?: string): CoreEvent {
    const seq = (this.seqs.get(topic) ?? 0) + 1
    this.seqs.set(topic, seq)
    const event: CoreEvent = { topic, seq, data, ...(ownerClientId !== undefined ? { ownerClientId } : {}) }
    if (OWNED_TOPICS.has(topic)) {
      const buffer = this.buffers.get(topic) ?? []
      buffer.push(event)
      if (buffer.length > REPLAY_BUFFER) buffer.shift()
      this.buffers.set(topic, buffer)
    }
    for (const { subscriber, topics } of this.subscriptions.values()) {
      if (topics.has(topic) && this.visibleTo(event, subscriber)) this.deliver(subscriber, event)
    }
    return event
  }

  /**
   * Adds `topics` to the subscriber's set. Each topic gets a replay (owned topics whose events
   * since `sinceSeq[topic]` are all still held) or a snapshot (everything else).
   */
  subscribe(subscriber: Subscriber, topics: string[], sinceSeq: Record<string, number> = {}): void {
    const entry = this.subscriptions.get(subscriber.clientId) ?? { subscriber, topics: new Set<string>() }
    this.subscriptions.set(subscriber.clientId, entry)
    for (const topic of topics) {
      entry.topics.add(topic)
      const since = sinceSeq[topic]
      const buffer = this.buffers.get(topic)
      const oldest = buffer?.[0]?.seq
      if (since !== undefined && OWNED_TOPICS.has(topic) && (oldest === undefined || oldest <= since + 1)) {
        for (const event of buffer ?? []) {
          if (event.seq > since && this.visibleTo(event, subscriber)) this.deliver(subscriber, event)
        }
        continue
      }
      const provider = this.snapshots.get(topic) ?? this.snapshots.get(`${topic.split(":")[0]}:`)
      subscriber.send({
        jsonrpc: "2.0",
        method: "event",
        params: { topic, seq: this.seqs.get(topic) ?? 0, snapshot: true, data: provider ? provider(subscriber) : null },
      })
    }
    this.changed()
  }

  unsubscribe(clientId: string, topics?: string[]): void {
    const entry = this.subscriptions.get(clientId)
    if (entry === undefined) return
    if (topics === undefined) this.subscriptions.delete(clientId)
    else for (const topic of topics) entry.topics.delete(topic)
    this.changed()
  }

  topicsOf(clientId: string): string[] {
    return [...(this.subscriptions.get(clientId)?.topics ?? [])]
  }

  private visibleTo(event: CoreEvent, subscriber: Subscriber): boolean {
    if (!OWNED_TOPICS.has(event.topic) || subscriber.role === "view") return true
    return event.ownerClientId === subscriber.clientId
  }

  private deliver(subscriber: Subscriber, event: CoreEvent): void {
    subscriber.send({
      jsonrpc: "2.0",
      method: "event",
      params: { topic: event.topic, seq: event.seq, data: event.data },
    })
  }
}
