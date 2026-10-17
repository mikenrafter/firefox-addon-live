/**
 * Minimal Marionette client (Firefox's remote protocol), first written for
 * zen-custom-context-menus. Speaks the length-prefixed JSON wire format over TCP.
 *
 * Packets: `<byteLength>:<json>`. Commands are `[0, id, name, params]`,
 * responses are `[1, id, error, body]`.
 */

export type MarionettePacket = unknown[]

export interface MarionetteSocket {
	on(event: string, listener: (...args: unknown[]) => void): unknown
	write(data: Uint8Array | string): boolean
	end(): void
}

export interface MarionetteConnectOptions {
	host?: string
	port?: number
	socket?: MarionetteSocket
	timeoutMs?: number
}

/** WebDriver element reference, as returned by ExecuteScript for DOM nodes. */
export type ElementReference = Record<string, string>

export function frameMarionetteMessage(message: MarionettePacket): string {
	const json = JSON.stringify(message)
	return `${new TextEncoder().encode(json).byteLength}:${json}`
}

export class MarionetteMessageParser {
	private bytes = new Uint8Array()

	push(chunk: Uint8Array | string): MarionettePacket[] {
		const incoming = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk
		const combined = new Uint8Array(this.bytes.length + incoming.length)
		combined.set(this.bytes)
		combined.set(incoming, this.bytes.length)
		this.bytes = combined
		const messages: MarionettePacket[] = []

		while (true) {
			const colon = this.bytes.indexOf(58)
			if (colon < 1) break
			const length = Number(new TextDecoder().decode(this.bytes.slice(0, colon)))
			if (!Number.isSafeInteger(length) || length < 0) throw new Error('Invalid Marionette packet length')
			const end = colon + 1 + length
			if (this.bytes.length < end) break
			const json = new TextDecoder().decode(this.bytes.slice(colon + 1, end))
			this.bytes = this.bytes.slice(end)
			messages.push(JSON.parse(json) as MarionettePacket)
		}
		return messages
	}
}

interface PendingRequest {
	resolve: (value: unknown) => void
	reject: (error: Error) => void
}

export class MarionetteClient {
	private readonly parser = new MarionetteMessageParser()
	private readonly pendingPackets: MarionettePacket[] = []
	private readonly packetWaiters: PendingRequest[] = []
	private readonly requests = new Map<number, PendingRequest>()
	private nextMessageId = 1
	private sessionId: string | undefined
	private closed = false

	private constructor(private readonly socket: MarionetteSocket, private readonly timeoutMs: number) {
		socket.on('data', (chunk: unknown) => {
			for (const packet of this.parser.push(chunk as Uint8Array | string)) this.receive(packet)
		})
		socket.on('error', (error: unknown) => this.failAll(asError(error)))
		socket.on('close', () => this.failAll(new Error('Marionette socket closed')))
	}

	static async connect(options: MarionetteConnectOptions = {}): Promise<MarionetteClient> {
		const socket = options.socket ?? await createSocket(options.host ?? '127.0.0.1', options.port ?? 2828)
		const client = new MarionetteClient(socket, options.timeoutMs ?? 15_000)
		const hello = await withTimeout(client.nextPacket(), client.timeoutMs, 'Marionette handshake timed out')
		const body = hello[0] === 0 && isObject(hello[1]) ? hello[1] : hello
		if (!isObject(body) || body.applicationType !== 'gecko') {
			socket.end()
			throw new Error('Invalid Marionette handshake')
		}
		return client
	}

	async createSession(capabilities: Record<string, unknown> = {}): Promise<string> {
		const value = await this.command('WebDriver:NewSession', { capabilities }) as Record<string, unknown>
		const sessionId = String(value.sessionId ?? '')
		if (!sessionId) throw new Error('Marionette did not return a session id')
		this.sessionId = sessionId
		return sessionId
	}

	async setContext(context: 'chrome' | 'content'): Promise<void> {
		await this.command('Marionette:SetContext', { value: context })
	}

	async executeScript(script: string, args: unknown[] = []): Promise<unknown> {
		const result = await this.command('WebDriver:ExecuteScript', { script, args })
		return isObject(result) ? result.value : result
	}

	/** `sandbox: 'system'` runs content scripts with system privileges (Xray access to the page). */
	async executeAsyncScript(script: string, args: unknown[] = [], sandbox?: string): Promise<unknown> {
		const result = await this.command('WebDriver:ExecuteAsyncScript', { script, args, ...(sandbox ? { sandbox } : {}) })
		return isObject(result) ? result.value : result
	}

	/** Points the content context at a tab; the handle is the WebDriver id of its browser. */
	async switchToWindow(handle: string, focus = true): Promise<void> {
		await this.command('WebDriver:SwitchToWindow', { handle, focus })
	}

	async navigate(url: string): Promise<void> {
		await this.command('WebDriver:Navigate', { url })
	}

	async setWindowRect(rect: { width: number, height: number, x?: number, y?: number }): Promise<void> {
		await this.command('WebDriver:SetWindowRect', rect)
	}

	/** Installs an unpacked or packed add-on. Temporary add-ons skip signature checks. */
	async installAddon(path: string, temporary = true): Promise<string> {
		const result = await this.command('Addon:Install', { path, temporary })
		const value = isObject(result) ? result.value : result
		if (typeof value !== 'string') throw new Error('Marionette did not return an add-on id')
		return value
	}

	/** Trusted (Marionette-dispatched) click on an element's centre. */
	async click(element: ElementReference, button = 0): Promise<void> {
		try {
			await this.command('WebDriver:PerformActions', {
				actions: [{
					type: 'pointer',
					id: 'firefox-addon-live-pointer',
					parameters: { pointerType: 'mouse' },
					actions: [
						{ type: 'pointerMove', duration: 0, origin: element, x: 0, y: 0 },
						{ type: 'pointerDown', button },
						{ type: 'pointerUp', button },
					],
				}],
			})
		} finally {
			await this.command('WebDriver:ReleaseActions', {})
		}
	}

	async close(): Promise<void> {
		if (this.closed) return
		this.closed = true
		try {
			if (this.sessionId) await this.command('WebDriver:DeleteSession', {})
		} finally {
			this.socket.end()
		}
	}

	private async command(name: string, parameters: Record<string, unknown>): Promise<unknown> {
		const id = this.nextMessageId++
		const response = new Promise<unknown>((resolve, reject) => {
			this.requests.set(id, { resolve, reject })
			this.socket.write(frameMarionetteMessage([0, id, name, {
				...parameters,
				...(this.sessionId ? { sessionId: this.sessionId } : {}),
			}]))
		})
		return await withTimeout(response, this.timeoutMs, `${name} timed out`)
	}

	private receive(packet: MarionettePacket): void {
		if (packet[0] === 1 && typeof packet[1] === 'number') {
			const pending = this.requests.get(packet[1])
			if (!pending) return
			this.requests.delete(packet[1])
			const error = packet[2]
			if (isObject(error) && error.error) {
				const stack = typeof error.stacktrace === 'string' ? `\n${error.stacktrace}` : ''
				pending.reject(new Error(`${String(error.error)}: ${String(error.message ?? '')}${stack}`))
			} else {
				pending.resolve(packet[3])
			}
			return
		}
		const waiter = this.packetWaiters.shift()
		if (waiter) waiter.resolve(packet)
		else this.pendingPackets.push(packet)
	}

	private nextPacket(): Promise<MarionettePacket> {
		const packet = this.pendingPackets.shift()
		if (packet) return Promise.resolve(packet)
		return new Promise<MarionettePacket>((resolve, reject) => {
			this.packetWaiters.push({ resolve: (value) => resolve(value as MarionettePacket), reject })
		})
	}

	private failAll(error: Error): void {
		for (const pending of this.requests.values()) pending.reject(error)
		this.requests.clear()
		for (const waiter of this.packetWaiters.splice(0)) waiter.reject(error)
	}
}

async function createSocket(host: string, port: number): Promise<MarionetteSocket> {
	const net = await import('node:net')
	return await new Promise<MarionetteSocket>((resolve, reject) => {
		const socket = net.createConnection({ host, port }, () => resolve(socket))
		socket.once('error', reject)
	})
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(message)), timeoutMs)
		promise.then(
			(value) => { clearTimeout(timer); resolve(value) },
			(error: unknown) => { clearTimeout(timer); reject(asError(error)) },
		)
	})
}

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object'
}

function asError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value))
}
