const config = require('../config')
const TOKEN_KEY = 'wechat_persona_settings_device'
let redirecting = false
const imageCache = new Map()
function base() {
  if (!/^https:\/\/[^/]+\/?$/.test(config.apiBase)) throw new Error('设置服务尚未接通，请联系管理者完成配置。')
  return config.apiBase.replace(/\/$/,'') + '/persona-wechat'
}
function reset() {
  wx.removeStorageSync(TOKEN_KEY); getApp().globalData.peerId = ''; imageCache.clear()
  if (!redirecting) { redirecting = true; wx.reLaunch({url:'/pages/bind/index',complete:()=>{redirecting=false}}) }
}
function request(path,body,anonymous=false) {
  let url
  try { url = base()+path } catch(error) { return Promise.reject(error) }
  const token = wx.getStorageSync(TOKEN_KEY)
  if (!anonymous && !token) { reset(); return Promise.reject(new Error('请先绑定')) }
  return new Promise((resolve,reject)=>wx.request({url,method:body===undefined?'GET':'POST',data:body,timeout:15000,header:{'Content-Type':'application/json','X-Settings-Request':'1','X-Settings-Client':'miniprogram',...(token?{Authorization:'Bearer '+token}:{})},success:res=>{
    if(res.statusCode===401 && !anonymous) reset()
    if(res.statusCode<200 || res.statusCode>=300 || res.data.ok===false) reject(new Error(res.data.error || res.data.message || (res.data.issues||[]).join('；') || '操作未完成'))
    else resolve(res.data)
  },fail:()=>reject(new Error('暂时连接不上服务，请检查网络。'))}))
}
async function bind(code) {
  const data = await request('/auth/exchange',{code:code.trim()},true)
  if(!data.token) throw new Error('绑定未完成')
  wx.setStorageSync(TOKEN_KEY,data.token); return data
}
async function context() {
  const [access,chats] = await Promise.all([request('/access'),request('/chats')])
  const current = getApp().globalData.peerId || access.peerId
  const peer = chats.some(chat=>chat.peerId===current)?current:chats[0]&&chats[0].peerId || ''
  getApp().globalData.peerId=peer
  return {access,chats,peer,chat:chats.find(chat=>chat.peerId===peer),peerNames:chats.map((chat,index)=>'联系人 '+(index+1)+' · '+chat.peerId.slice(0,8)),peerIndex:Math.max(0,chats.findIndex(chat=>chat.peerId===peer))}
}
function choosePeer(page,event) {
  const chat=page.data.context.chats[Number(event.detail.value)]
  if(chat) { getApp().globalData.peerId=chat.peerId; page.reload() }
}
function toast(title) { wx.showToast({title,icon:'none',duration:2200}) }
function confirm(content) { return new Promise(resolve=>wx.showModal({title:'请确认',content,confirmText:'继续',confirmColor:'#242428',success:r=>resolve(r.confirm),fail:()=>resolve(false)})) }
async function download(peer,id) {
  const key=peer+'|'+id
  if(imageCache.has(key)) return imageCache.get(key)
  const url=base()+'/sticker/image?peerId='+encodeURIComponent(peer)+'&id='+encodeURIComponent(id)
  const promise=new Promise((resolve,reject)=>wx.downloadFile({url,header:{Authorization:'Bearer '+wx.getStorageSync(TOKEN_KEY)},timeout:15000,success:r=>r.statusCode===200?resolve(r.tempFilePath):reject(new Error('图片暂时不可用')),fail:()=>reject(new Error('图片加载失败'))}))
  imageCache.set(key,promise)
  try { return await promise } catch(error) { imageCache.delete(key); throw error }
}
async function previews(peer,images) {
  let offset=0; const out=new Array(images.length)
  await Promise.all(Array.from({length:Math.min(4,images.length)},async()=>{
    while(offset<images.length) { const index=offset++; const image=images[index]; try { out[index]={...image,preview:await download(peer,image.id)} } catch { out[index]={...image,preview:''} } }
  }))
  return out
}
function dirty() { if(wx.enableAlertBeforeUnload) wx.enableAlertBeforeUnload({message:'还有未保存的修改，确定离开？'}) }
function saved() { if(wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload() }
module.exports={request,bind,context,choosePeer,toast,confirm,download,previews,dirty,saved,reset,hasToken:()=>!!wx.getStorageSync(TOKEN_KEY)}
