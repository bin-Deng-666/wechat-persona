/** 常驻设置服务的装配。数据操作不依赖 DSH；实时对话控制通过私有 socket 转给 bot。 */
import { createApiClient } from '../../../../src/ilink/api.ts'
import { LoginSession } from '../auth/session.ts'
import { forgetAccount, saveAccount } from '../../../../src/auth/credentials.ts'
import { renderQrSvg } from '../auth/qr.ts'
import { seedDefaultPersona } from '../../../../src/persona/store.ts'
import { SettingsRepository } from './repository.ts'
import { SettingsServer } from './server.ts'
import { hostSocket, type SettingsConfig } from './config.ts'
import { rpcCall } from './rpc.ts'
import type { PanelStatus } from './routes.ts'

export async function startSettingsService(dataDir: string,config?: SettingsConfig) {
  const repository = new SettingsRepository(dataDir)
  await repository.memory.load()
  await seedDefaultPersona(repository.personas.root)
  const login = new LoginSession({
    api:createApiClient({channelVersion:'0.3.0-dev.0',botAgent:'wechat-persona-settings'}),renderQr:renderQrSvg,
    onConnected:async credentials => { await saveAccount(dataDir,{accountId:credentials.accountId,baseUrl:credentials.baseUrl,botToken:credentials.botToken,...(credentials.userId ? {userId:credentials.userId} : {})}) },
  })
  const status = async (): Promise<PanelStatus> => {
    try { return {...await rpcCall<PanelStatus>(hostSocket(dataDir),'status',{},1500),login:login.view()} }
    catch { return {connected:false,botOnline:false,login:{...login.view(),message:'Bot 当前离线，设置仍可查看和修改。'},dataDir} }
  }
  const handlers = repository.handlers({
    status,begin:async () => await login.begin(),poll:async () => await login.poll(),
    verifyCode:async code => { login.submitVerifyCode(code); return await login.poll() },
    logout:async () => { await forgetAccount(dataDir); login.reset(); return login.view() },
    control:async (peerId,action) => {
      try { return await rpcCall<{ok:boolean;message:string}>(hostSocket(dataDir),'control',{peerId,action},120000) }
      catch { return {ok:false,message:'Bot 当前离线。设置可以保存，对话操作需等 Bot 上线。'} }
    },
  })
  const server = new SettingsServer(handlers,{dataDir,config})
  const links = await server.start()
  return {server,links,repository,close:async () => await server.close()}
}
