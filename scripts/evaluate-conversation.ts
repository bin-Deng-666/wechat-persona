/** Fixed multi-turn model evaluation. Uses an isolated headless profile; never starts WeChat. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PeerSystemPrompt } from '../src/dsh/system-prompt.ts'
import { PeerMemory } from '../src/memory/store.ts'
import { ChatSettingsStore } from '../src/chat/settings.ts'
import { PersonaStore } from '../src/persona/store.ts'
import { StickerLibrary } from '../src/stickers/library.ts'
import { parsePersonaCard } from '../src/persona/card.ts'

let cases = [
  { id: 'emotion', focus: '回应感受，采用不要建议的更正，允许自然结束', turns: ['今天好累。', '不用给建议，我就想吐槽一下。', '嗯，先这样。'] },
  { id: 'correction', focus: '后续采用用户更正，不沿用错误原因', turns: ['帮我起草一条给同事的道歉短信，因为我迟到了。先给一句。', '纠正一下，我没有迟到，是我把会议时间记错了。别沿用刚才的原因。'] },
  { id: 'enough-information', focus: '信息足够时推进，避免重复追问', turns: ['给初学者解释一下 JavaScript 闭包，带一个小例子。', '再用同一个例子解释变量为什么没有消失。'] },
  { id: 'depth', focus: '回答充分程度随当前请求改变，单条字数不限制整个回答', turns: ['只用一句话回答：你在吗？', '现在详细解释一下，为什么睡眠不足会影响注意力？'] },
  { id: 'ending', focus: '确认和道别不机械追加问题', turns: ['谢谢，先这样。', '晚安。'] },
]
const args = process.argv.slice(2)
const option = (flag: string, fallback: string) => { const at = args.indexOf(flag); return at < 0 ? fallback : args[at + 1] ?? fallback }
const output = resolve(option('--output', '/tmp/wechat-conversation-evaluation.json'))
const executable = option('--dsh', process.env.DSH_BIN ?? 'dsh')
const root = await mkdtemp(join(tmpdir(), 'wechat-quality-'))
const report: { status: string; rubric: string[]; cases: { id: string; focus: string; transcript: { user: string; assistant: string }[] }[]; error?: string } = {
  status: 'running', rubric: ['是否接住当前意图', '是否采用最新更正', '是否重复追问或建议', '是否有无依据的承诺或事实', '是否自然结束', '长度和分条是否适合语境'], cases: [],
}
try {
  let personaId = 'default'
  const personaPath = option('--persona', '')
  if (personaPath) {
    const parsed = parsePersonaCard(JSON.parse(await readFile(resolve(personaPath), 'utf8')))
    if (!parsed.ok || parsed.warnings.length) throw new Error(`Invalid evaluation persona: ${JSON.stringify(parsed)}`)
    personaId = parsed.card.id
    await mkdir(join(root, 'personas', personaId), { recursive: true })
    await writeFile(join(root, 'personas', personaId, 'persona.json'), JSON.stringify(parsed.card))
  }
  const casePath = option('--cases', '')
  if (casePath) {
    const input: unknown = JSON.parse(await readFile(resolve(casePath), 'utf8'))
    if (!Array.isArray(input) || !input.length || input.some(item => !item || typeof item.id !== 'string' || typeof item.focus !== 'string' || !Array.isArray(item.turns) || !item.turns.length || item.turns.some((turn: unknown) => typeof turn !== 'string' || !turn.trim()))) throw new Error('Evaluation cases require id, focus and nonempty user turns')
    cases = input
  }
  const memory = new PeerMemory(join(root, 'memory')); await memory.load()
  const prompts = new PeerSystemPrompt({ personas: new PersonaStore(join(root, 'personas')), settings: new ChatSettingsStore(join(root, 'settings')), memory, stickers: new StickerLibrary(join(root, 'stickers')), defaultPersona: () => personaId })
  const system = await prompts.render('synthetic-evaluation-contact')
  if (args.includes('--dry-run')) {
    await writeFile(output, JSON.stringify({ ...report, status: 'prepared', system, scenarios: cases }, null, 2))
    console.log(`Prepared ${cases.length} scenarios: ${output}`)
  } else {
    const plugin = join(root, 'evaluation.mjs'), patch = join(root, 'evaluation.yml')
    await writeFile(plugin, `export const name = 'wechat-conversation-evaluation';\nexport const inject = ['systemPrompt', 'tools'];\nexport function apply(ctx) { ctx.systemPrompt.section({name:'wechat-evaluation',order:11000,interpolate:false,text:${JSON.stringify(system)}}); ctx.tools.guard(() => 'Conversation evaluation: tools are disabled'); }\n`)
    await writeFile(patch, `- insert:\n    - id: wechat-evaluation\n      name: ${JSON.stringify(plugin)}\n`)
    const run = promisify(execFile)
    for (const scenario of cases) {
      const result = { id: scenario.id, focus: scenario.focus, transcript: [] as { user: string; assistant: string }[] }
      report.cases.push(result)
      let sessionId: string | undefined
      for (const user of scenario.turns) {
        const command = ['--profile', 'headless', '--patch', patch, '--json', ...(sessionId ? ['--session-id', sessionId] : []), user]
        const { stdout } = await run(executable, command, { timeout: 45000, maxBuffer: 2 * 1024 * 1024, cwd: root, encoding: 'utf8' })
        const events = stdout.split('\n').filter(line => line.trim().startsWith('{')).map(line => JSON.parse(line) as { type: string; sessionId?: string; text?: string })
        sessionId = events.find(event => event.type === 'session')?.sessionId ?? sessionId
        if (!sessionId) throw new Error('Headless did not return a session ID')
        const assistant = events.findLast(event => event.type === 'final')?.text
        if (!assistant?.trim()) throw new Error('Headless returned no final response')
        result.transcript.push({ user, assistant })
        await writeFile(output, JSON.stringify(report, null, 2))
        console.log(`${scenario.id}: ${result.transcript.length}/${scenario.turns.length}`)
      }
    }
    report.status = 'complete'
    await writeFile(output, JSON.stringify(report, null, 2))
    console.log(`Review transcripts using the rubric: ${output}`)
  }
} catch (error) {
  const detail = error as { stderr?: string; message?: string }
  report.status = 'blocked'; report.error = (detail.stderr ?? detail.message ?? String(error)).slice(0, 2000)
  await writeFile(output, JSON.stringify(report, null, 2))
  console.error(report.error); process.exitCode = 1
} finally { await rm(root, { recursive: true, force: true }) }
