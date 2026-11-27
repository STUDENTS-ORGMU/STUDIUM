import { supabase } from './supabase.js';

const ref = (kind, path) => ({ __ref: true, kind, path });
const pathOf = parts => parts.filter(Boolean).join('/');
export const db = {};
export const collection = (_db, ...parts) => ref('collection', pathOf(parts));
export const doc = (base, ...parts) => {
  if (base?.__ref) return ref('document', pathOf([base.path, ...(parts.length ? parts : [crypto.randomUUID()])]));
  return ref('document', pathOf(parts));
};
export const where = (field, op, value) => ({ type: 'where', field, op, value });
export const orderBy = (field, direction = 'asc') => ({ type: 'order', field, direction });
export const query = (source, ...constraints) => ({ __query: true, source, constraints });
export const serverTimestamp = () => new Date().toISOString();

const parse = path => path.split('/').filter(Boolean);
const isRecord = p => p[0] === 'groups' && p.length >= 3 && !['members','materialFiles'].includes(p[2]);
const recordInfo = p => ({ groupId: p[1], collection: p[2] });
const snap = (id, data, documentRef) => ({ id, ref: documentRef, exists: () => data !== null, data: () => data });
const fail = error => { if (error) throw error; };
const mapRecord = row => row ? { id: row.record_id, ...row.data } : null;

async function readOne(path) {
  const p = parse(path);
  if (p[0] === 'groups' && p.length === 2) {
    const { data, error } = await supabase.from('study_groups').select('*').eq('id', p[1]).maybeSingle(); fail(error);
    return data ? { id: data.id, name: data.name, ...data.data, createdBy: data.created_by } : null;
  }
  if (p[0] === 'groups' && p[2] === 'members' && p.length === 4) {
    const { data, error } = await supabase.from('group_members').select('*').eq('group_id',p[1]).eq('user_id',p[3]).maybeSingle(); fail(error);
    return data ? { userId:data.user_id, displayName:data.display_name, role:data.role, joinedAt:data.joined_at, ...data.data, avatarPath:data.avatar_path || data.data?.avatarPath || null } : null;
  }
  if (p[0] === 'users' && p.length === 2) {
    const { data, error } = await supabase.from('profiles').select('*').eq('id',p[1]).maybeSingle(); fail(error);
    return data ? { username:data.username, fullName:data.full_name, patronymic:data.patronymic, ...data.data } : null;
  }
  if (p[0] === 'inviteCodes' && p.length === 2) {
    const { data, error } = await supabase.from('invite_codes').select('*').eq('code',p[1]).maybeSingle(); fail(error);
    return data ? { groupId:data.group_id, ...data.data } : null;
  }
  if (isRecord(p)) {
    const { data, error } = await supabase.from('group_records').select('*').eq('group_id',p[1]).eq('collection_name',p[2]).eq('record_id',p[3]).maybeSingle(); fail(error);
    return mapRecord(data);
  }
  return null;
}
async function readCollection(source, constraints = []) {
  const p = parse(source.path);
  let rows = [];
  if (p[0] === 'groups' && p.length === 3 && p[2] === 'members') {
    const { data, error } = await supabase.from('group_members').select('*').eq('group_id',p[1]); fail(error);
    rows = (data||[]).map(x=>({id:x.user_id,userId:x.user_id,displayName:x.display_name,role:x.role,joinedAt:x.joined_at,...x.data,avatarPath:x.avatar_path || x.data?.avatarPath || null}));
  } else if (isRecord(p)) {
    let q = supabase.from('group_records').select('record_id,data,created_at').eq('group_id',p[1]).eq('collection_name',p[2]);
    const { data, error } = await q; fail(error);
    rows=(data||[]).map(x=>({id:x.record_id,...x.data}));
  }
  for (const c of constraints) {
    if(c.type==='where') rows=rows.filter(x=>String(x[c.field]??'')===String(c.value));
    if(c.type==='order') rows.sort((a,b)=>String(a[c.field]??'').localeCompare(String(b[c.field]??''))*(c.direction==='desc'?-1:1));
  }
  return rows;
}
export async function getDoc(documentRef) {
  const data = await readOne(documentRef.path);
  return snap(parse(documentRef.path).at(-1), data, documentRef);
}
export async function getDocs(input) {
  const source=input.__query?input.source:input;
  const constraints=input.__query?input.constraints:[];
  const rows=await readCollection(source,constraints);
  const docs=rows.map(x=>snap(x.id,x,doc(db,...parse(source.path),x.id)));
  return {docs,empty:docs.length===0,size:docs.length,forEach:fn=>docs.forEach(fn)};
}
async function writeOne(documentRef, data, mode='set', merge=false) {
  const p=parse(documentRef.path), id=p.at(-1), payload={...data};
  if(p[0]==='groups'&&p.length===2){
    const old = (merge || mode==='update') ? (await readOne(documentRef.path) || {}) : {};
    const next = { ...old, ...payload };
    const {error}=await supabase.from('study_groups').upsert({id,name:next.name||'Учебная группа',created_by:next.createdBy||null,data:Object.fromEntries(Object.entries(next).filter(([k])=>!['id','name','createdBy','createdAt','updatedAt'].includes(k)))},{onConflict:'id'}); fail(error); return;
  }
  if(p[0]==='groups'&&p[2]==='members'&&p.length===4){
    const old = (merge || mode==='update') ? (await readOne(documentRef.path) || {}) : {};
    const next = { ...old, ...payload };
    const {error}=await supabase.from('group_members').upsert({group_id:p[1],user_id:p[3],role:next.role||'student',display_name:next.displayName||'',avatar_path:next.avatarPath ?? old.avatarPath ?? null,data:Object.fromEntries(Object.entries(next).filter(([k])=>!['id','role','displayName','userId','joinedAt','avatarPath'].includes(k)))},{onConflict:'group_id,user_id'}); fail(error); return;
  }
  if(p[0]==='users'&&p.length===2){
    const {error}=await supabase.from('profiles').update({username:payload.username,full_name:payload.fullName,patronymic:payload.patronymic,updated_at:new Date().toISOString()}).eq('id',p[1]); fail(error); return;
  }
  if(p[0]==='inviteCodes'&&p.length===2){
    const {error}=await supabase.from('invite_codes').upsert({code:id,group_id:payload.groupId,created_by:payload.createdBy||null,data:Object.fromEntries(Object.entries(payload).filter(([k])=>!['groupId','createdBy','createdAt'].includes(k)))},{onConflict:'code'}); fail(error); return;
  }
  if(isRecord(p)){
    let next=payload;
    if(merge){const old=await readOne(documentRef.path); next={...(old||{}),...payload};}
    const {error}=await supabase.from('group_records').upsert({group_id:p[1],collection_name:p[2],record_id:id,owner_user_id:supabase.auth.getUser? (await supabase.auth.getUser()).data.user?.id:null,data:next,updated_at:new Date().toISOString()},{onConflict:'group_id,collection_name,record_id'}); fail(error); return;
  }
}
export async function setDoc(r,data,options={}){return writeOne(r,data,'set',!!options.merge);}
export async function updateDoc(r,data){return writeOne(r,data,'update',true);}
export async function addDoc(c,data){const id=crypto.randomUUID();const r=doc(c,id);await setDoc(r,data);return r;}
export async function deleteDoc(r){
 const p=parse(r.path);
 if(isRecord(p)){const {error}=await supabase.from('group_records').delete().eq('group_id',p[1]).eq('collection_name',p[2]).eq('record_id',p[3]);fail(error);}
 else if(p[0]==='groups'&&p.length===2){const {error}=await supabase.from('study_groups').delete().eq('id',p[1]);fail(error);}
 else if(p[0]==='groups'&&p[2]==='members'){const {error}=await supabase.from('group_members').delete().eq('group_id',p[1]).eq('user_id',p[3]);fail(error);}
}
export function writeBatch(){
 const ops=[];
 return {set:(r,d,o={})=>ops.push(()=>setDoc(r,d,o)),update:(r,d)=>ops.push(()=>updateDoc(r,d)),delete:r=>ops.push(()=>deleteDoc(r)),commit:async()=>{for(const op of ops)await op();}};
}
export async function runTransaction(_db,callback){
 const ops=[];
 const tx={get:getDoc,set:(r,d)=>ops.push(()=>setDoc(r,d)),update:(r,d)=>ops.push(()=>updateDoc(r,d)),delete:r=>ops.push(()=>deleteDoc(r))};
 const result=await callback(tx); for(const op of ops)await op(); return result;
}
export function onSnapshot(input,next,error){
 let stopped=false, busy=false;
 const poll=async()=>{if(stopped||busy)return;busy=true;try{next(await getDocs(input));}catch(e){error?.(e);}finally{busy=false;}};
 poll(); const timer=setInterval(poll,8000);
 return ()=>{stopped=true;clearInterval(timer);};
}
