import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { db } from './db.js';

export type AdminToken = { adminId?: string; email: string; companyId: string; role: 'OWNER'|'ADMIN'|'MANAGER'; exp: number };

const secret = () => process.env.ADMIN_TOKEN_SECRET ?? '';
const safeEqual = (a:string,b:string) => {
  const l=createHash('sha256').update(a).digest();
  const r=createHash('sha256').update(b).digest();
  return timingSafeEqual(l,r);
};
export const signAdminToken=(p:AdminToken)=>{
  const b=Buffer.from(JSON.stringify(p)).toString('base64url');
  const s=createHmac('sha256',secret()).update(b).digest('base64url');
  return `${b}.${s}`;
};
export const verifyAdminToken=(token:string):AdminToken|null=>{
  if(!secret()) return null;
  const [b,s]=token.split('.'); if(!b||!s)return null;
  const expected=createHmac('sha256',secret()).update(b).digest('base64url');
  if(!safeEqual(s,expected))return null;
  try{
    const p=JSON.parse(Buffer.from(b,'base64url').toString('utf8')) as AdminToken;
    return p.email&&p.companyId&&p.role&&p.exp>=Date.now()?p:null;
  }catch{return null}
};
export const requireAdmin=(request:any,reply:any):AdminToken|null=>{
  const h=String(request.headers.authorization??'');
  const p=verifyAdminToken(h.startsWith('Bearer ')?h.slice(7):'');
  if(!p){reply.code(401).send({ok:false,error:'ADMIN_AUTH_REQUIRED'});return null}
  return p;
};

const successfulLogin=async(a:any)=>{
  const expiresAt=Date.now()+8*60*60*1000;
  if(a.id){
    await db.query('update company_admins set last_login_at=now() where id=$1',[a.id]);
    await db.query(`insert into audit_log(company_id,actor_type,actor_id,action,entity_type,entity_id,metadata) values($1::uuid,'ADMIN',$2::text,'ADMIN_LOGIN','COMPANY_ADMIN',$2::text,jsonb_build_object('email',$3::text))`,[a.companyId,String(a.id),String(a.email)]);
  }
  return {status:200,body:{ok:true,token:signAdminToken({adminId:a.id,email:a.email,companyId:a.companyId,role:a.role??'OWNER',exp:expiresAt}),expiresAt,companyId:a.companyId,email:a.email,role:a.role??'OWNER',companyName:a.companyName}};
};

export async function loginCompanyAdmin(body:unknown){
  const parsed=z.object({email:z.email(),password:z.string().min(8).max(256)}).safeParse(body);
  if(!parsed.success)return {status:400,body:{ok:false,error:'INVALID_LOGIN_REQUEST'}};
  const email=parsed.data.email.trim().toLowerCase();
  const r=await db.query(`select ca.id,ca.company_id as "companyId",ca.email,ca.role,c.name as "companyName" from company_admins ca join companies c on c.id=ca.company_id where lower(ca.email)=lower($1) and ca.active=true and ca.password_hash=crypt($2,ca.password_hash) limit 1`,[email,parsed.data.password]);
  if(r.rowCount)return successfulLogin(r.rows[0]);

  const legacyEmail=(process.env.ADMIN_EMAIL??'').trim().toLowerCase();
  const legacyPassword=process.env.ADMIN_PASSWORD??'';
  const legacyCompanyId=process.env.ADMIN_COMPANY_ID??'';
  if(secret()&&legacyEmail&&legacyPassword&&legacyCompanyId&&safeEqual(email,legacyEmail)&&safeEqual(parsed.data.password,legacyPassword)){
    const company=await db.query('select name from companies where id=$1 limit 1',[legacyCompanyId]);
    if(company.rowCount)return successfulLogin({email:legacyEmail,companyId:legacyCompanyId,role:'OWNER',companyName:company.rows[0].name});
  }
  return {status:401,body:{ok:false,error:'INVALID_ADMIN_CREDENTIALS'}};
}

export async function bootstrapLegacyAdmin(){
  const email=(process.env.ADMIN_EMAIL??'').trim().toLowerCase(),password=process.env.ADMIN_PASSWORD??'',companyId=process.env.ADMIN_COMPANY_ID??'';
  if(!email||!password||!companyId)return;
  await db.query(`insert into company_admins(company_id,email,password_hash,role) select $1,$2,crypt($3,gen_salt('bf')),'OWNER' where exists(select 1 from companies where id=$1) and not exists(select 1 from company_admins where lower(email)=lower($2))`,[companyId,email,password]);
}
