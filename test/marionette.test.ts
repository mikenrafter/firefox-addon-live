import { describe, expect, it } from 'vitest'

import {
	MarionetteClient,
	MarionetteMessageParser,
	frameMarionetteMessage,
	type MarionettePacket,
	type MarionetteSocket,
} from '../src/marionette'

class FakeSocket implements MarionetteSocket {
	readonly commands: MarionettePacket[] = []
	private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>()

	constructor(private readonly replies: MarionettePacket[]) {
		queueMicrotask(() => this.emit(this.replies.shift()!))
	}

	on(event: string, listener: (...args: unknown[]) => void): this {
		this.listeners.set(event, [...this.listeners.get(event) ?? [], listener])
		return this
	}

	write(data: Uint8Array | string): boolean {
		const [command] = new MarionetteMessageParser().push(data)
		this.commands.push(command!)
		const reply = this.replies.shift()
		if (reply) queueMicrotask(() => this.emit(reply))
		return true
	}

	end(): void {}

	private emit(packet: MarionettePacket): void {
		for (const listener of this.listeners.get('data') ?? []) listener(frameMarionetteMessage(packet))
	}
}

describe('Marionette wire protocol', () => {
	it('frames JSON using its UTF-8 byte length', () => {
		expect(frameMarionetteMessage([0, 1, 'WebDriver:NewSession', { label: 'café' }]))
			.toBe('46:[0,1,"WebDriver:NewSession",{"label":"café"}]')
	})

	it('unframes split and coalesced packets', () => {
		const parser = new MarionetteMessageParser()
		const bytes = new TextEncoder().encode(
			frameMarionetteMessage([0, 1, 'hello', {}]) + frameMarionetteMessage([1, 1, null, { ok: true }]),
		)
		expect(parser.push(bytes.slice(0, 7))).toEqual([])
		expect(parser.push(bytes.slice(7))).toEqual([
			[0, 1, 'hello', {}],
			[1, 1, null, { ok: true }],
		])
	})

	it('creates a session, runs commands with the session id, and surfaces errors', async () => {
		const socket = new FakeSocket([
			[0, { applicationType: 'gecko', marionetteProtocol: 3 }],
			[1, 1, null, { sessionId: 'session-1', capabilities: {} }],
			[1, 2, null, null],
			[1, 3, null, { value: 'cont@bmarks' }],
			[1, 4, { error: 'javascript error', message: 'boom' }, null],
			[1, 5, null, null],
		])
		const client = await MarionetteClient.connect({ socket })

		expect(await client.createSession()).toBe('session-1')
		await client.setContext('chrome')
		expect(await client.installAddon('/addon')).toBe('cont@bmarks')
		await expect(client.executeScript('throw 1')).rejects.toThrow('javascript error: boom')
		await client.close()

		expect(socket.commands.map((command) => command[2])).toEqual([
			'WebDriver:NewSession',
			'Marionette:SetContext',
			'Addon:Install',
			'WebDriver:ExecuteScript',
			'WebDriver:DeleteSession',
		])
		expect(socket.commands[2]?.[3]).toEqual({ path: '/addon', temporary: true, sessionId: 'session-1' })
	})

	it('rejects a non-Gecko handshake', async () => {
		const socket = new FakeSocket([[0, { applicationType: 'other' }]])
		await expect(MarionetteClient.connect({ socket })).rejects.toThrow('Invalid Marionette handshake')
	})
})
