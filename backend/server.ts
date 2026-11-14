import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isProductionEmailConfigured, resolveClientOrigin, resolveJwtSecret, resolvePort, resolveTrustProxy } from './security';
import { installMatchingRoutes } from './matching-routes';
import { installAdminRoutes } from './admin-routes';
import { match, parseSkillList } from './matching';
import { getAdminDashboardMetrics, getRecentAdminAuditLogs } from './admin-dashboard';
import { installSensitiveRouteRateLimits } from './rate-limiting';
import { sendPasswordResetEmail } from './password-reset-email';

type Role = 'fundi'|'foreman'|'assessor'|'administrator';
type AuthedRequest = Request & { user?: { id:string; role:Role; name:string; email:string; sessionId?:string } };
class UnsupportedEvidenceTypeError extends Error {}
const app = express();
const port = resolvePort(process.env);
const jwtSecret = resolveJwtSecret(process.env);
const allowedClientOrigin = resolveClientOrigin(process.env);
const trustProxy = resolveTrustProxy(process.env);
if (process.env.NODE_ENV === 'production'
  && (!process.env.DATABASE_FILE || !path.isAbsolute(process.env.DATABASE_FILE)
    || !process.env.UPLOAD_DIR || !path.isAbsolute(process.env.UPLOAD_DIR))) {
  throw new Error('Production requires absolute DATABASE_FILE and UPLOAD_DIR paths on persistent storage.');
}
const { databaseFile, db } = await import('./db');
const developmentMode = process.env.NODE_ENV !== 'production';
const uploadDir = path.resolve(process.env.UPLOAD_DIR || './uploads');
fs.mkdirSync(uploadDir,{recursive:true});
const clientBuildDir = path.resolve('dist');
const clientIndexFile = path.join(clientBuildDir, 'index.html');
if (!developmentMode && !fs.existsSync(clientIndexFile)) {
 throw new Error(`Production frontend build was not found at ${clientIndexFile}. Run npm run build before starting the server.`);
}
const evidenceTypes: Record<string, { mimeType: string; signature: (content: Buffer) => boolean }> = {
 '.pdf': { mimeType: 'application/pdf', signature: (content) => content.subarray(0, 5).toString('ascii') === '%PDF-' },
 '.jpg': { mimeType: 'image/jpeg', signature: (content) => content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff },
 '.jpeg': { mimeType: 'image/jpeg', signature: (content) => content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff },
 '.png': { mimeType: 'image/png', signature: (content) => content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
};
app.set('trust proxy', trustProxy);
app.use(cors({ origin: allowedClientOrigin }));
installSensitiveRouteRateLimits(app, process.env);
app.use(express.json({limit:'5mb'}));
app.use((req,res,next)=>{
 if(req.path.startsWith('/api/')&&req.body!==undefined&&(!req.body||typeof req.body!=='object'||Array.isArray(req.body))){
  return res.status(400).json({error:'Request body must be a JSON object.'});
 }
 if(req.path.startsWith('/api/')&&req.body&&Object.hasOwn(req.body,'password')
  &&(typeof req.body.password!=='string'||req.body.password.length>200)){
  return res.status(400).json({error:'Password must be text with no more than 200 characters.'});
 }
 next();
});
const now=()=>new Date().toISOString();
const id=()=>randomUUID();
const clean=(v:unknown,max=500)=>String(v??'').trim().slice(0,max);
const maskedEmail=(email:string)=>{const [local,domain]=email.split('@');return domain?`${local.slice(0,1)}***@${domain}`:'<invalid email>';};
const sessionLifetimeSeconds=7*24*60*60;
function clientOrigin(req:Request){
 if(process.env.NODE_ENV==='production')return allowedClientOrigin;
 const candidate=req.get('origin')||req.get('referer');
 if(candidate){
  try{
   const requested=new URL(candidate);
   const configuredOrigin=allowedClientOrigin;
   if(requested.origin===configuredOrigin||['localhost','127.0.0.1','[::1]'].includes(requested.hostname))return requested.origin;
  }catch{}
 }
 return allowedClientOrigin;
}
const sign=(u:any)=>{
 const sessionId=randomUUID();
 const issuedAt=Math.floor(Date.now()/1000);
 const expiresAt=issuedAt+sessionLifetimeSeconds;
 const token=jwt.sign({id:u.id,role:u.role,name:u.name,email:u.email,authVersion:u.auth_version??0,jti:sessionId,iat:issuedAt,exp:expiresAt},jwtSecret);
 db.prepare('INSERT INTO auth_sessions (session_id,user_id,expires_at,created_at) VALUES (?,?,?,?)')
  .run(sessionId,u.id,new Date(expiresAt*1000).toISOString(),now());
 return token;
};
function auth(req:AuthedRequest,res:Response,next:NextFunction){
 const token=req.headers.authorization?.replace(/^Bearer\s+/i,'');
 if(!token)return res.status(401).json({error:'Please sign in to continue.'});
 let claims:jwt.JwtPayload & {id?:string;role?:Role;name?:string;email?:string;authVersion?:number;jti?:string};
 try{claims=jwt.verify(token,jwtSecret) as typeof claims;}
 catch{return res.status(401).json({error:'Your session has expired. Please sign in again.'});}
 if(typeof claims.id!=='string'||typeof claims.role!=='string'||typeof claims.jti!=='string')return res.status(401).json({error:'Your session has expired. Please sign in again.'});
 const currentUser=db.prepare(`SELECT user.auth_version FROM auth_sessions session
  JOIN users user ON user.id=session.user_id
  WHERE session.session_id=? AND session.user_id=? AND session.revoked_at=''
    AND session.expires_at>?`).get(claims.jti,claims.id,now()) as {auth_version:number}|undefined;
 if(!currentUser||(claims.authVersion??0)!==currentUser.auth_version)return res.status(401).json({error:'Your session has expired. Please sign in again.'});
 req.user={id:claims.id,role:claims.role as Role,name:claims.name||'',email:claims.email||'',sessionId:claims.jti};
 next();
}
function roles(...allowed:Role[]){return (req:AuthedRequest,res:Response,next:NextFunction)=>{if(!req.user||!allowed.includes(req.user.role))return res.status(403).json({error:'Your account role cannot perform this action.'});next();};}
function audit(userId:string,action:string,target:string,details=''){db.prepare('INSERT INTO audit_logs VALUES (?,?,?,?,?,?)').run(id(),userId,action,target,clean(details,300),now());}
function normalizeDisputeStatus(value:unknown){
 const raw=String(value??'').trim().toLowerCase().replace(/[_\s-]+/g,'_');
 const mapping:Record<string,string>={
  'open':'open',
  'under_review':'under_review',
  'under review':'under_review',
  'resolved':'resolved',
  'rejected':'rejected',
  'closed':'closed'
 };
 return mapping[raw]||'open';
}
function disputeStatusLabel(status:string){
 const labels:Record<string,string>={
  open:'Open',
  under_review:'Under review',
  resolved:'Resolved',
  rejected:'Rejected',
  closed:'Closed',
 };
 return labels[status]||'Open';
}
function notify(userId:string,title:string,message:string,options:{eventKey?:string;link?:string}={}){
 const eventKey=String(options.eventKey||'');
 const link=String(options.link||'');
 const notificationId=id();
 const inserted=db.prepare(`INSERT INTO notifications (id,user_id,title,message,read,created_at,link,event_key)
  VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(user_id,event_key) WHERE event_key<>'' DO NOTHING`)
  .run(notificationId,userId,title,message,0,now(),link,eventKey);
 if(!inserted.changes){
  if(eventKey){
   const existing=db.prepare('SELECT id FROM notifications WHERE user_id=? AND event_key=?').get(userId,eventKey) as {id:string}|undefined;
   if(existing)return existing.id;
  }
  throw new Error('Notification insert was skipped without a matching deduplication record.');
 }
 return notificationId;
}
function refreshUserVerificationStatus(userId:string){
 const result=db.prepare(`SELECT
  EXISTS(SELECT 1 FROM evidence WHERE user_id=? AND status='verified') AS has_verified,
  EXISTS(SELECT 1 FROM evidence WHERE user_id=? AND status='pending') AS has_pending,
  EXISTS(SELECT 1 FROM evidence WHERE user_id=? AND status='rejected') AS has_rejected,
  EXISTS(SELECT 1 FROM evidence WHERE user_id=?) AS has_evidence`)
  .get(userId,userId,userId,userId) as {has_verified:number;has_pending:number;has_rejected:number;has_evidence:number};
 const status=result.has_verified?'verified':result.has_pending?'pending':result.has_rejected?'rejected':result.has_evidence?'unable_to_verify':'pending';
 db.prepare('UPDATE users SET verification_status=? WHERE id=?').run(status,userId);
 return status;
}
const upload=multer({
 storage:multer.diskStorage({
  destination:uploadDir,
  filename:(_req,file,cb)=>cb(null,`${Date.now()}-${randomUUID()}${path.extname(file.originalname).toLowerCase()}`),
 }),
 limits:{fileSize:5*1024*1024},
 fileFilter:(_req,file,cb)=>{
  const extension=path.extname(file.originalname).toLowerCase();
  if(evidenceTypes[extension]?.mimeType===file.mimetype)cb(null,true);
  else cb(new UnsupportedEvidenceTypeError('Upload a PDF, JPEG or PNG file.'));
 },
});
function isValidEvidenceContent(filePath:string,extension:string){
 const type=evidenceTypes[extension];
 return Boolean(type&&type.signature(fs.readFileSync(filePath)));
}
function removeUploadedFile(filePath:string){
 try{fs.unlinkSync(filePath);}catch(error){
  if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
 }
}
const matchingRoutes=installMatchingRoutes({db,auth,roles,clean,id,now,sign,audit,notify});
app.use(matchingRoutes);
app.use(installAdminRoutes({
 db,auth,roles,clean,id,now,
 hashPassword:(password)=>bcrypt.hash(password,12),
 audit,
}));
app.get('/api/health',(_req,res)=>res.json({status:'ok',service:'FundiConnect Local API'}));
app.post('/api/auth/forgot-password',async(req,res)=>{
 if(process.env.NODE_ENV==='production'&&!isProductionEmailConfigured(process.env))return res.status(503).json({error:'Password reset email delivery is not configured.'});
 const requestId=id();
 try{
  const email=clean(req.body.email,160).toLowerCase();
  const user:any=email?db.prepare('SELECT id FROM users WHERE email=?').get(email):undefined;
  if(developmentMode)console.info(`[password-reset] pid=${process.pid} request=${requestId} accountFound=${Boolean(user)} email=${maskedEmail(email)} database=${databaseFile}`);
  db.prepare('DELETE FROM password_resets WHERE expires_at<=?').run(now());
  if(user){
   const token=randomBytes(32).toString('hex');
   const tokenHash=createHash('sha256').update(token).digest('hex');
   const expiresAt=new Date(Date.now()+30*60*1000).toISOString();
   db.prepare('DELETE FROM password_resets WHERE user_id=?').run(user.id);
   db.prepare('INSERT INTO password_resets (token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)').run(tokenHash,user.id,expiresAt,now());
   const link=`${clientOrigin(req)}/?resetToken=${token}`;
   if(developmentMode)console.info(`[password-reset] pid=${process.pid} request=${requestId} link (development only, expires in 30 minutes): ${link}`);
   else{
    try{await sendPasswordResetEmail(process.env,email,link);}
    catch{
     db.prepare('DELETE FROM password_resets WHERE token_hash=?').run(tokenHash);
     console.error(`[password-reset] pid=${process.pid} request=${requestId} email delivery failed`);
    }
   }
  }
  res.json({message:developmentMode?'If an account exists for that email, a password reset link has been generated. In this local edition, check the API server console.':'If an account exists and email delivery is available, password reset instructions will be sent.'  });
 }catch(error){
  if(developmentMode)console.error(`[password-reset] pid=${process.pid} request=${requestId} failed:`,error instanceof Error?error.message:'Unknown error');
  res.status(500).json({error:'Could not create a password reset request.'});
 }
});
app.post('/api/auth/reset-password',async(req,res)=>{
 const token=clean(req.body.token,128);
 const password=String(req.body.password??'');
 if(!/^[a-f0-9]{64}$/i.test(token)||password.length<8)return res.status(400).json({error:'Provide a valid reset link and a password of at least 8 characters.'});
 const tokenHash=createHash('sha256').update(token).digest('hex');
 const pendingReset:any=db.prepare('SELECT expires_at FROM password_resets WHERE token_hash=?').get(tokenHash);
 if(!pendingReset)return res.status(400).json({error:'This password reset link is invalid or has expired. Request a new one.'});
 if(Date.parse(pendingReset.expires_at)<=Date.now()){
  db.prepare('DELETE FROM password_resets WHERE token_hash=?').run(tokenHash);
  return res.status(400).json({error:'This password reset link is invalid or has expired. Request a new one.'});
 }
 const passwordHash=await bcrypt.hash(password,12);
 const completeReset=db.transaction(()=>{
  const reset:any=db.prepare('SELECT user_id,expires_at FROM password_resets WHERE token_hash=?').get(tokenHash);
  if(!reset||Date.parse(reset.expires_at)<=Date.now())return false;
  const updated=db.prepare('UPDATE users SET password_hash=?,auth_version=auth_version+1 WHERE id=?').run(passwordHash,reset.user_id);
  if(!updated.changes)return false;
   db.prepare("UPDATE auth_sessions SET revoked_at=? WHERE user_id=? AND revoked_at=''").run(now(),reset.user_id);
   db.prepare('DELETE FROM password_resets WHERE user_id=?').run(reset.user_id);
  return true;
 });
 if(!completeReset())return res.status(400).json({error:'This password reset link is invalid or has expired. Request a new one.'});
 res.json({message:'Your password has been reset. You can now sign in with your new password.'});
});
app.post('/api/auth/logout',auth,(req:AuthedRequest,res)=>{
 db.transaction(()=>{
  db.prepare("UPDATE auth_sessions SET revoked_at=? WHERE session_id=? AND user_id=? AND revoked_at=''")
   .run(now(),req.user!.sessionId!,req.user!.id);
  audit(req.user!.id,'session.revoked',req.user!.id,'logout');
 }).immediate();
 res.status(204).end();
});
app.post('/api/auth/register',async(req,res)=>{try{const name=clean(req.body.name,100),email=clean(req.body.email,160).toLowerCase(),password=String(req.body.password||''),role=clean(req.body.role) as Role;if(!name||!email||password.length<8||!['fundi','foreman'].includes(role))return res.status(400).json({error:'Provide a name, valid email, password (at least 8 characters) and a permitted role.'});if(db.prepare('SELECT id FROM users WHERE email=?').get(email))return res.status(409).json({error:'An account with this email already exists.'});const user={id:id(),name,email,password_hash:await bcrypt.hash(password,12),role,phone:clean(req.body.phone,30),trade:clean(req.body.trade,80),location:clean(req.body.location,100),experience:Math.max(0,Math.min(60,Number(req.body.experience)||0)),availability:clean(req.body.availability,60)||'Available',bio:clean(req.body.bio,500),verification_status:'pending',created_at:now()};db.prepare('INSERT INTO users (id,name,email,password_hash,role,phone,trade,location,experience,availability,bio,verification_status,created_at) VALUES (@id,@name,@email,@password_hash,@role,@phone,@trade,@location,@experience,@availability,@bio,@verification_status,@created_at)').run(user);audit(user.id,'account.created',user.id,role);const {password_hash,...safe}=user;res.status(201).json({token:sign(user),user:safe});}catch(e:any){res.status(500).json({error:e.message||'Could not create account.'});}});
app.post('/api/auth/login',async(req,res)=>{const email=clean(req.body.email,160).toLowerCase(),password=String(req.body.password||'');const user:any=db.prepare('SELECT * FROM users WHERE email=?').get(email);if(!user||!(await bcrypt.compare(password,user.password_hash)))return res.status(401).json({error:'Email or password is incorrect.'});const {password_hash,...safe}=user;res.json({token:sign(user),user:safe});});
app.get('/api/me',auth,(req:AuthedRequest,res)=>{const u:any=db.prepare('SELECT * FROM users WHERE id=?').get(req.user!.id);if(!u)return res.status(404).json({error:'Account not found.'});const {password_hash,...safe}=u;res.json({profile:{...safe,skills:parseSkillList(u.skills)}});});
app.patch('/api/me',auth,(req:AuthedRequest,res)=>{const fields=['name','phone','trade','location','experience','availability','bio'];const current:any=db.prepare('SELECT * FROM users WHERE id=?').get(req.user!.id);const values:any={};for(const f of fields)if(req.body[f]!==undefined)values[f]=f==='experience'?Math.max(0,Math.min(60,Number(req.body[f])||0)):clean(req.body[f],f==='bio'?500:120);const keys=Object.keys(values);if(keys.length)db.prepare(`UPDATE users SET ${keys.map(k=>`${k}=@${k}`).join(',')} WHERE id=@id`).run({...values,id:current.id});res.json({profile:db.prepare('SELECT id,name,email,role,phone,trade,location,experience,availability,bio,verification_status,created_at FROM users WHERE id=?').get(current.id)});});
app.get('/api/dashboard',auth,(req:AuthedRequest,res)=>{
 const user=req.user!;
 const count=(sql:string,...params:unknown[])=>Number((db.prepare(sql).get(...params) as {n:number}).n);
 const myApplications=user.role==='fundi'
  ?count('SELECT COUNT(*) n FROM applications WHERE fundi_id=?',user.id)
  :user.role==='foreman'
   ?count('SELECT COUNT(*) n FROM applications application JOIN jobs job ON job.id=application.job_id WHERE job.foreman_id=?',user.id)
   :user.role==='administrator'?count('SELECT COUNT(*) n FROM applications'):0;
 res.json({
  role:user.role,
  openJobs:count("SELECT COUNT(*) n FROM jobs WHERE status='open'"),
  myApplications,
  ownedJobs:user.role==='foreman'?count('SELECT COUNT(*) n FROM jobs WHERE foreman_id=?',user.id):0,
  pendingEvidence:count("SELECT COUNT(*) n FROM evidence WHERE status='pending'"),
 });
});
app.get('/api/jobs',auth,(req:AuthedRequest,res)=>{
 const user=req.user!;
 const jobs=user.role==='administrator'
  ?db.prepare('SELECT * FROM jobs ORDER BY created_at DESC').all()
  :user.role==='foreman'
   ?db.prepare('SELECT * FROM jobs WHERE foreman_id=? ORDER BY created_at DESC').all(user.id)
   :db.prepare("SELECT * FROM jobs WHERE status='open' ORDER BY created_at DESC").all();
 res.json({jobs});
});
app.get('/api/fundis',auth,roles('foreman','assessor','administrator'),(_req,res)=>res.json({fundis:db.prepare("SELECT id,name,role,trade,location,experience,availability,bio,verification_status,created_at FROM users WHERE role='fundi' ORDER BY created_at DESC").all()}));
app.post('/api/evidence',auth,roles('fundi'),upload.single('file'),(req:AuthedRequest,res)=>{
 if(!req.file)return res.status(400).json({error:'Evidence title and a file are required.'});
 if(!clean(req.body.title)){removeUploadedFile(req.file.path);return res.status(400).json({error:'Evidence title and a file are required.'});}
 const extension=path.extname(req.file.originalname).toLowerCase();
 let validContent=false;
 try{validContent=isValidEvidenceContent(req.file.path,extension);}
 catch(error){removeUploadedFile(req.file.path);throw error;}
 if(!validContent){removeUploadedFile(req.file.path);return res.status(415).json({error:'The file content does not match an allowed PDF, JPEG or PNG type.'});}
 const evidenceId=id();
 try{
  db.transaction(()=>{
   db.prepare('INSERT INTO evidence (id,user_id,title,evidence_type,file_name,file_path,description,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(evidenceId,req.user!.id,clean(req.body.title,120),clean(req.body.evidenceType,80),req.file!.originalname,req.file!.filename,clean(req.body.description,1000),'pending',now());
   refreshUserVerificationStatus(req.user!.id);
   notify(req.user!.id,'Evidence submitted','Your skills evidence is awaiting review.');
   audit(req.user!.id,'evidence.submitted',evidenceId,req.file!.originalname);
  }).immediate();
 }catch(error){removeUploadedFile(req.file.path);throw error;}
 res.status(201).json({id:evidenceId,status:'pending'});
});
app.get('/api/evidence/:id/file',auth,(req:AuthedRequest,res)=>{
 const item:any=db.prepare('SELECT id,user_id,file_name,file_path FROM evidence WHERE id=?').get(req.params.id);
 if(!item)return res.status(404).json({error:'Evidence file not found.'});
 if(item.user_id!==req.user!.id&&!['assessor','administrator'].includes(req.user!.role))return res.status(404).json({error:'Evidence file not found.'});
 const storedName=String(item.file_path||'');
 if(!storedName||storedName.includes('\0')||path.basename(storedName)!==storedName)return res.status(404).json({error:'Evidence file not found.'});
 const filePath=path.resolve(uploadDir,storedName);
 const relativePath=path.relative(uploadDir,filePath);
 if(!relativePath||relativePath.startsWith(`..${path.sep}`)||path.isAbsolute(relativePath))return res.status(404).json({error:'Evidence file not found.'});
 const extension=path.extname(storedName).toLowerCase();
 const type=evidenceTypes[extension];
 if(!type||!fs.existsSync(filePath))return res.status(404).json({error:'Evidence file not found.'});
 const content=fs.readFileSync(filePath);
 if(!type.signature(content))return res.status(404).json({error:'Evidence file not found.'});
 const downloadName=path.basename(String(item.file_name||`evidence${extension}`)).replace(/[\r\n"]/g,'_').slice(0,180);
 res.set({
  'Content-Type':type.mimeType,
  'Content-Disposition':`attachment; filename="evidence${extension}"; filename*=UTF-8''${encodeURIComponent(downloadName)}`,
  'Content-Length':String(content.length),
  'Cache-Control':'private, no-store',
  'X-Content-Type-Options':'nosniff',
  'Content-Security-Policy':"default-src 'none'; sandbox",
 });
 res.send(content);
});
app.put('/api/evidence/:id/review',auth,roles('assessor','administrator'),(req:AuthedRequest,res)=>{
 const item:any=db.prepare('SELECT * FROM evidence WHERE id=?').get(req.params.id);
 if(!item)return res.status(404).json({error:'Evidence record not found.'});
 const status=clean(req.body.status);
 if(!['verified','rejected','unable_to_verify'].includes(status))return res.status(400).json({error:'Choose a valid review outcome.'});
 const reviewedAt=now();
 db.transaction(()=>{
  db.prepare('UPDATE evidence SET status=?,reviewer_id=?,reviewer_name=?,review_notes=?,reviewed_at=? WHERE id=?')
   .run(status,req.user!.id,req.user!.name,clean(req.body.notes,1000),reviewedAt,item.id);
  refreshUserVerificationStatus(item.user_id);
  notify(item.user_id,'Evidence review completed',`Your evidence status is now ${status}.`);
  audit(req.user!.id,'evidence.reviewed',item.id,status);
 }).immediate();
 res.json({status});
});
app.get('/api/my-records',auth,(req:AuthedRequest,res)=>{
 const user=req.user!;
 const rows=(table:string,where:string,params:unknown[])=>db.prepare(`SELECT * FROM ${table} WHERE ${where} ORDER BY created_at DESC`).all(...params);
 const admin=user.role==='administrator',reviewer=admin||user.role==='assessor';
 const applicationRows=user.role==='fundi'
  ?db.prepare(`SELECT application.*,job.status AS job_status,
     COALESCE((SELECT MAX(log.created_at) FROM audit_logs log
       WHERE log.target=application.id AND log.action LIKE 'application.%'),application.created_at) AS updated_at
     FROM applications application
   JOIN jobs job ON job.id=application.job_id WHERE application.fundi_id=? ORDER BY application.created_at DESC`).all(user.id)
  :user.role==='foreman'
  ?db.prepare(`SELECT application.*,job.status AS job_status,
     COALESCE((SELECT MAX(log.created_at) FROM audit_logs log
       WHERE log.target=application.id AND log.action LIKE 'application.%'),application.created_at) AS updated_at,
     worker.trade AS applicant_trade,
     worker.location AS applicant_location,worker.experience AS applicant_experience,
      worker.experience_unit AS applicant_experience_unit,worker.skills AS applicant_skills,
      worker.availability AS applicant_availability,worker.verification_status AS applicant_verification_status,
      worker.bio AS applicant_bio
      FROM applications application JOIN jobs job ON job.id=application.job_id
      JOIN users worker ON worker.id=application.fundi_id AND worker.role='fundi'
      WHERE job.foreman_id=? ORDER BY application.created_at DESC`).all(user.id)
   :admin?db.prepare(`SELECT application.*,job.status AS job_status FROM applications application
      JOIN jobs job ON job.id=application.job_id ORDER BY application.created_at DESC`).all():[];
 const applications=(applicationRows as Record<string,any>[]).map((application)=>({
  ...application,
  status:application.status==='submitted'?'pending':application.status,
  updated_at:application.updated_at||application.created_at,
 }));
 res.json({
  applications,
  evidence:reviewer?db.prepare('SELECT * FROM evidence ORDER BY created_at DESC').all():rows('evidence','user_id=?',[user.id]),
  assignments:admin?db.prepare('SELECT * FROM assignments ORDER BY created_at DESC').all():rows('assignments','foreman_id=? OR worker_id=?',[user.id,user.id]),
  verifications:reviewer?db.prepare('SELECT * FROM evidence ORDER BY created_at DESC').all():rows('evidence','user_id=?',[user.id]),
  disputes:admin?db.prepare('SELECT * FROM disputes ORDER BY created_at DESC').all():rows('disputes','user_id=? OR foreman_id=? OR other_party_id=?',[user.id,user.id,user.id]),
 });
});
app.post('/api/crew',auth,roles('foreman','administrator'),(req:AuthedRequest,res)=>{
 const reqs=Array.isArray(req.body.requirements)?req.body.requirements:[];
 if(!reqs.length)return res.status(400).json({error:'At least one trade requirement is needed.'});
 const users:any[]=db.prepare("SELECT id,name,trade,location,experience,experience_unit,skills,availability,verification_status FROM users WHERE role='fundi'").all();
 const members:any[]=[];const shortages:any[]=[];
 for(const r of reqs.slice(0,12)){
  const quantity=Number(r.quantity);
  if(typeof r.trade!=='string'||!Number.isInteger(quantity)||quantity<1||quantity>100)return res.status(400).json({error:'Crew trades and quantities must be valid.'});
  const candidates=users.filter(u=>(u.trade||'').toLowerCase()===clean(r.trade,80).toLowerCase())
   .map(u=>match({trade:r.trade,location:req.body.location,min_experience:0,verification_required:false},u))
   .filter(candidate=>candidate.eligible).sort((a,b)=>b.score-a.score);
  members.push(...candidates.slice(0,quantity));
  if(candidates.length<quantity)shortages.push({trade:r.trade,quantity:quantity-candidates.length});
 }
 res.json({crew:{requirements:reqs,members,shortages}});
});
const assignmentColumns=`a.id,a.foreman_id,a.worker_id,a.worker_name,a.job_id,a.task,a.start_date,a.end_date,a.payment,a.status,a.created_at,
 job.title AS job_title,job.trade AS job_trade,job.location AS job_location,worker.name AS fundi_name`;
function assignmentForUser(assignmentId:string,user:NonNullable<AuthedRequest['user']>){
 const assignment:any=db.prepare(`SELECT ${assignmentColumns},job.foreman_id AS job_foreman_id FROM assignments a
  LEFT JOIN jobs job ON job.id=a.job_id
  JOIN users worker ON worker.id=a.worker_id AND worker.role='fundi'
  WHERE a.id=?`).get(assignmentId);
 if(!assignment)return null;
 if(user.role==='administrator'||(user.role==='foreman'&&assignment.foreman_id===user.id
  &&(!assignment.job_foreman_id||assignment.job_foreman_id===user.id))
  ||(user.role==='fundi'&&assignment.worker_id===user.id))return assignment;
 return null;
}
app.get('/api/assignments',auth,(req:AuthedRequest,res)=>{
 const user=req.user!;
 if(!['fundi','foreman','administrator'].includes(user.role))return res.status(403).json({error:'Your account role cannot view assignments.'});
 const filter=user.role==='fundi'?'a.worker_id=?':user.role==='foreman'?'a.foreman_id=?':'1=1';
 const params=user.role==='administrator'?[]:[user.id];
 const assignments:any[]=db.prepare(`SELECT ${assignmentColumns} FROM assignments a
  LEFT JOIN jobs job ON job.id=a.job_id
  JOIN users worker ON worker.id=a.worker_id AND worker.role='fundi'
  WHERE ${filter} ORDER BY a.created_at DESC`).all(...params);
 res.json({assignments:assignments.map((a)=>({...a,status:a.status==='active'?'in_progress':a.status}))});
});
app.get('/api/assignments/:id',auth,(req:AuthedRequest,res)=>{
 const assignment=assignmentForUser(clean(req.params.id,100),req.user!);
 if(!assignment)return res.status(404).json({error:'Assignment not found or access denied.'});
 const attendance=db.prepare(`SELECT id,status,date,verification_status,verified_at
  FROM attendance WHERE assignment_id=? ORDER BY date DESC,created_at DESC`).all(assignment.id);
 const progress=db.prepare(`SELECT log.id,log.details,log.created_at,user.name AS actor_name,user.role AS actor_role
  FROM audit_logs log LEFT JOIN users user ON user.id=log.user_id
  WHERE log.target=? AND log.action='assignment.progress' ORDER BY log.created_at DESC`).all(assignment.id);
 const review=db.prepare(`SELECT rating,feedback,status,created_at FROM performance_reviews
  WHERE assignment_id=? AND worker_id=? AND status='published' ORDER BY created_at DESC LIMIT 1`).get(assignment.id,assignment.worker_id);
 res.json({assignment:{...assignment,status:assignment.status==='active'?'in_progress':assignment.status},attendance,progress,review});
});
app.get('/api/jobs/:id/crew',auth,roles('foreman','administrator'),(req:AuthedRequest,res)=>{
 const job:any=db.prepare('SELECT id,foreman_id FROM jobs WHERE id=?').get(clean(req.params.id,100));
 if(!job||(req.user!.role!=='administrator'&&job.foreman_id!==req.user!.id))return res.status(404).json({error:'Job not found or access denied.'});
 const crew:any[]=db.prepare(`SELECT ${assignmentColumns} FROM assignments a
  LEFT JOIN jobs job ON job.id=a.job_id
  JOIN users worker ON worker.id=a.worker_id AND worker.role='fundi'
  WHERE a.job_id=? AND a.foreman_id=? ORDER BY a.created_at`).all(job.id,job.foreman_id);
 res.json({crew:crew.map((a)=>({...a,status:a.status==='active'?'in_progress':a.status}))});
});
app.post('/api/assignments',auth,roles('foreman','administrator'),(req:AuthedRequest,res)=>{
 const applicationId=clean(req.body.applicationId,100);
 if(!applicationId)return res.status(400).json({error:'Select an accepted application to create an assignment.'});
 const created=db.transaction(()=>{
  const application:any=db.prepare('SELECT * FROM applications WHERE id=?').get(applicationId);
  if(!application||application.status!=='accepted')return {error:true as const,message:'Only accepted applications can become assignments.',status:409 as const};
  const job:any=db.prepare('SELECT * FROM jobs WHERE id=?').get(application.job_id);
  const worker:any=db.prepare("SELECT id,name,trade,location,experience,experience_unit,skills,availability,verification_status FROM users WHERE id=? AND role='fundi'").get(application.fundi_id);
  if(!job||!worker||application.foreman_id!==job.foreman_id||application.job_id!==job.id)return {error:true as const,message:'The accepted application is no longer valid.',status:409 as const};
  if(req.user!.role!=='administrator'&&job.foreman_id!==req.user!.id)return {error:true as const,message:'Job not found or access denied.',status:404 as const};
  const matchResult=match({trade:job.trade,location:job.location,min_experience:job.min_experience,min_experience_unit:job.min_experience_unit,required_skills:job.required_skills,verification_required:!!job.verification_required},worker);
  if(!matchResult.eligible)return {error:true as const,message:'The applicant no longer meets this job’s eligibility requirements.',status:409 as const};
  if(db.prepare('SELECT id FROM assignments WHERE job_id=? AND worker_id=?').get(job.id,worker.id))return {error:true as const,message:'This applicant already has an assignment for the job.',status:409 as const};
  const assignmentId=id();
  db.prepare(`INSERT INTO assignments (id,foreman_id,worker_id,worker_name,job_id,task,start_date,end_date,payment,status,created_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(assignmentId,job.foreman_id,worker.id,worker.name,job.id,job.title,job.start_date||'', '',job.pay||0,'assigned',now());
  notify(worker.id,'New work assignment',`${req.user!.name} assigned you to ${job.title}.`);
  audit(req.user!.id,'assignment.created',assignmentId,`${worker.name} · ${job.title}`);
  return {error:false as const,id:assignmentId,assignment:{id:assignmentId,worker_id:worker.id,worker_name:worker.name,job_id:job.id,task:job.title,status:'assigned'}};
 }).immediate();
 if(created.error)return res.status(created.status).json({error:created.message});
 return res.status(201).json({id:created.id,assignment:created.assignment});
});
app.patch('/api/assignments/:id',auth,roles('foreman','administrator'),(req:AuthedRequest,res)=>{
 const assignment=assignmentForUser(clean(req.params.id,100),req.user!);
 if(!assignment)return res.status(404).json({error:'Assignment not found or access denied.'});
 const allowed=['task','startDate','endDate','payment'];
 if(Object.keys(req.body).some(key=>!allowed.includes(key))||!Object.keys(req.body).length)return res.status(400).json({error:'Only task, dates and payment can be edited.'});
 const task=req.body.task===undefined?assignment.task:clean(req.body.task,300);
 const startDate=req.body.startDate===undefined?assignment.start_date:clean(req.body.startDate,10);
 const endDate=req.body.endDate===undefined?assignment.end_date:clean(req.body.endDate,10);
 const payment=req.body.payment===undefined?assignment.payment:Number(req.body.payment);
 const validDate=(value:string)=>{
  if(!value)return true;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
  const parsed=new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime())&&parsed.toISOString().slice(0,10)===value;
 };
 if(!task||task.length>300||!validDate(startDate)||!validDate(endDate)||(startDate&&endDate&&endDate<startDate)||!Number.isFinite(payment)||payment<0)
  return res.status(400).json({error:'Provide a valid task, date range and non-negative payment.'});
 const updated=db.transaction(()=>{
  const current:any=db.prepare('SELECT status FROM assignments WHERE id=?').get(assignment.id);
  if(!current||['completed','cancelled'].includes(current.status))return false;
  db.prepare('UPDATE assignments SET task=?,start_date=?,end_date=?,payment=? WHERE id=?').run(task,startDate,endDate,payment,assignment.id);
  audit(req.user!.id,'assignment.updated',assignment.id,task);
  return true;
 }).immediate();
 if(!updated)return res.status(409).json({error:'Completed or cancelled assignments cannot be edited.'});
 return res.json({ok:true});
});
app.patch('/api/assignments/:id/status',auth,roles('foreman','administrator'),(req:AuthedRequest,res)=>{
 const assignment=assignmentForUser(clean(req.params.id,100),req.user!);
 if(!assignment)return res.status(404).json({error:'Assignment not found or access denied.'});
 const next=clean(req.body.status,30);
 const transitions:Record<string,string[]>={assigned:['in_progress','cancelled'],in_progress:['completed','cancelled']};
 const result=db.transaction(()=>{
  const saved:any=db.prepare('SELECT status FROM assignments WHERE id=?').get(assignment.id);
  const current=saved?.status==='active'?'in_progress':saved?.status;
  if(!transitions[current]?.includes(next))return {error:true as const};
  db.prepare('UPDATE assignments SET status=? WHERE id=?').run(next,assignment.id);
  notify(assignment.worker_id,`Assignment ${next}`,`Your assignment for ${assignment.job_title||assignment.task} is now ${next}.`);
  audit(req.user!.id,`assignment.${next}`,assignment.id,`${current} -> ${next}`);
  return {error:false as const};
 }).immediate();
 if(result.error)return res.status(409).json({error:'That assignment status transition is not allowed.'});
 return res.json({id:assignment.id,status:next});
});
app.post('/api/assignments/:id/progress',auth,roles('fundi'),(req:AuthedRequest,res)=>{
 const assignment=assignmentForUser(clean(req.params.id,100),req.user!);
 if(!assignment)return res.status(404).json({error:'Assignment not found or access denied.'});
 if(!['assigned','in_progress','active'].includes(assignment.status))return res.status(409).json({error:'Progress cannot be added to a completed or cancelled assignment.'});
 const progress=typeof req.body.progress==='string'?req.body.progress.trim():'';
 if(!progress||progress.length>1000)return res.status(400).json({error:'Progress updates must contain 1 to 1000 characters.'});
 const logId=id();
 const created=db.transaction(()=>{
  const current:any=db.prepare('SELECT status FROM assignments WHERE id=? AND worker_id=?').get(assignment.id,req.user!.id);
  if(!current||!['assigned','in_progress','active'].includes(current.status))return false;
  db.prepare("INSERT INTO audit_logs (id,user_id,action,target,details,created_at) VALUES (?,?,?,?,?,?)")
   .run(logId,req.user!.id,'assignment.progress',assignment.id,progress,now());
  notify(assignment.foreman_id,'Assignment progress updated',`${assignment.worker_name} posted a progress update for ${assignment.job_title||assignment.task}.`);
  return true;
 }).immediate();
 if(!created)return res.status(409).json({error:'Progress cannot be added to a completed or cancelled assignment.'});
 return res.status(201).json({id:logId});
});
function validAttendanceDate(value:unknown,assignment:Record<string,any>){
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
 const parsed=new Date(`${value}T00:00:00.000Z`);
 if(Number.isNaN(parsed.getTime())||parsed.toISOString().slice(0,10)!==value||value>now().slice(0,10))return false;
 for(const [field,bound] of [['start_date','start'],['end_date','end']] as const){
  const date=String(assignment[field]||'');
  if(date){
   if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return false;
   const boundDate=new Date(`${date}T00:00:00.000Z`);
   if(Number.isNaN(boundDate.getTime())||boundDate.toISOString().slice(0,10)!==date)return false;
   if((bound==='start'&&value<date)||(bound==='end'&&value>date))return false;
  }
 }
 return true;
}
function attendanceStatus(value:unknown){
 return value==='present'||value==='absent'||value==='late'?value:null;
}
function hasForgedAttendanceFields(body:Record<string,unknown>){
 return ['verificationStatus','verification_status','verifiedBy','verified_by','verifiedAt','verified_at','recordedBy','recorded_by'].some((key)=>key in body);
}
app.post('/api/assignments/:id/attendance',auth,roles('foreman','administrator'),(req:AuthedRequest,res)=>{
 const assignment:any=db.prepare('SELECT * FROM assignments WHERE id=?').get(req.params.id);
 if(!assignment||(req.user!.role!=='administrator'&&assignment.foreman_id!==req.user!.id))return res.status(404).json({error:'Assignment not found or access denied.'});
 if(['completed','cancelled'].includes(assignment.status))return res.status(409).json({error:'Attendance cannot be changed for a completed or cancelled assignment.'});
 if(hasForgedAttendanceFields(req.body))return res.status(400).json({error:'Attendance verification fields are assigned by the server.'});
 const status=attendanceStatus(req.body.status);
 const date=req.body.date;
 if(!status)return res.status(400).json({error:'Attendance status must be present, late or absent.'});
 if(!validAttendanceDate(date,assignment))return res.status(400).json({error:'Attendance date must be a valid date within the assignment period and cannot be in the future.'});
 if(req.body.workerId!==undefined&&clean(req.body.workerId,100)!==assignment.worker_id)return res.status(400).json({error:'Attendance worker must match the assigned fundi.'});
 const attendanceId=id();
 const recordedAt=now();
 const write=db.transaction(()=>{
  const current:any=db.prepare('SELECT status FROM assignments WHERE id=?').get(assignment.id);
  if(!current||['completed','cancelled'].includes(current.status))return 'closed' as const;
  if(db.prepare('SELECT id FROM attendance WHERE assignment_id=? AND date=?').get(assignment.id,date))return 'duplicate' as const;
  db.prepare(`INSERT INTO attendance
   (id,assignment_id,worker_id,foreman_id,status,date,recorded_by,created_at,verification_status,verified_by,verified_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
   .run(attendanceId,assignment.id,assignment.worker_id,assignment.foreman_id,status,date,req.user!.id,recordedAt,'verified',req.user!.id,recordedAt);
  audit(req.user!.id,'attendance.verified',attendanceId,`${status} ${date}`);
  return 'created' as const;
 }).immediate();
 if(write==='closed')return res.status(409).json({error:'Attendance cannot be changed for a completed or cancelled assignment.'});
 if(write==='duplicate')return res.status(409).json({error:'Attendance has already been recorded for this assignment and date.'});
 return res.status(201).json({id:attendanceId,status,verificationStatus:'verified'});
});
app.patch('/api/attendance/:id',auth,roles('foreman','administrator'),(req:AuthedRequest,res)=>{
 const attendance:any=db.prepare(`SELECT attendance.*,assignment.foreman_id AS assignment_foreman_id,
  assignment.worker_id AS assignment_worker_id,assignment.start_date,assignment.end_date
  FROM attendance JOIN assignments assignment ON assignment.id=attendance.assignment_id
  WHERE attendance.id=?`).get(req.params.id);
 if(!attendance||(req.user!.role!=='administrator'&&(attendance.assignment_foreman_id!==req.user!.id||attendance.foreman_id!==req.user!.id)))
  return res.status(404).json({error:'Attendance not found or access denied.'});
  const assignment:any=db.prepare('SELECT status FROM assignments WHERE id=?').get(attendance.assignment_id);
  if(!assignment||['completed','cancelled'].includes(assignment.status))return res.status(409).json({error:'Attendance cannot be changed for a completed or cancelled assignment.'});
  if(hasForgedAttendanceFields(req.body))return res.status(400).json({error:'Attendance verification fields are assigned by the server.'});
  const status=req.body.status===undefined?attendanceStatus(attendance.status):attendanceStatus(req.body.status);
 const date=req.body.date===undefined?attendance.date:req.body.date;
 if(!status)return res.status(400).json({error:'Attendance status must be present, late or absent.'});
 if(!validAttendanceDate(date,attendance))return res.status(400).json({error:'Attendance date must be a valid date within the assignment period and cannot be in the future.'});
 if(req.body.workerId!==undefined&&clean(req.body.workerId,100)!==attendance.assignment_worker_id)
  return res.status(400).json({error:'Attendance worker must match the assigned fundi.'});
 const verifiedAt=now();
 const write=db.transaction(()=>{
  const current:any=db.prepare('SELECT status FROM assignments WHERE id=?').get(attendance.assignment_id);
  if(!current||['completed','cancelled'].includes(current.status))return 'closed' as const;
  if(db.prepare('SELECT id FROM attendance WHERE assignment_id=? AND date=? AND id<>?').get(attendance.assignment_id,date,attendance.id))return 'duplicate' as const;
  db.prepare(`UPDATE attendance SET status=?,date=?,recorded_by=?,verification_status='verified',verified_by=?,verified_at=? WHERE id=?`)
   .run(status,date,req.user!.id,req.user!.id,verifiedAt,attendance.id);
  audit(req.user!.id,'attendance.updated',attendance.id,`${status} ${date}`);
  return 'updated' as const;
 }).immediate();
 if(write==='closed')return res.status(409).json({error:'Attendance cannot be changed for a completed or cancelled assignment.'});
 if(write==='duplicate')return res.status(409).json({error:'Attendance has already been recorded for this assignment and date.'});
 return res.json({id:attendance.id,status,verificationStatus:'verified'});
});
function sanitizeDisputeRow(row:any){
 if(!row)return null;
 const status=normalizeDisputeStatus(row.status);
 return {
  ...row,
  status,
  status_label:disputeStatusLabel(status),
  category:row.category||'general',
  other_party_id:row.other_party_id||row.foreman_id||'',
  job_id:row.job_id||'',
  assignment_id:row.assignment_id||'',
  updated_at:row.updated_at||row.created_at,
  resolution_note:row.resolution_note||'',
  admin_id:row.admin_id||'',
  admin_name:row.admin_name||'',
 };
}
function connectedDisputeParticipant(jobId:string|undefined,assignmentId:string|undefined,userId:string,otherPartyId:string){
 const other=clean(otherPartyId,100);
 if(assignmentId){
  const assignment:any=db.prepare(`SELECT a.id,a.foreman_id,a.worker_id,a.job_id,j.foreman_id as job_foreman_id
   FROM assignments a LEFT JOIN jobs j ON j.id=a.job_id WHERE a.id=?`).get(clean(assignmentId,100));
  if(!assignment)return {valid:false,reason:'This assignment does not exist.'};
  if(jobId&&jobId!==assignment.job_id)return {valid:false,reason:'The job does not match the assignment.'};
  const isConnected=userId===assignment.worker_id||userId===assignment.foreman_id||userId===assignment.job_foreman_id;
  if(!isConnected)return {valid:false,reason:'You are not connected to that assignment.'};
  const inferred=assignment.worker_id===userId?assignment.foreman_id:assignment.worker_id;
  if(other && other!==inferred) return {valid:false,reason:'The other party does not match the assignment.'};
  return {valid:true,otherPartyId:inferred||'',jobId:assignment.job_id||jobId||''};
 }
 if(jobId){
  const job:any=db.prepare('SELECT id,foreman_id FROM jobs WHERE id=?').get(clean(jobId,100));
  if(!job)return {valid:false,reason:'This job does not exist.'};
  const acceptedApplicant=db.prepare("SELECT fundi_id FROM applications WHERE job_id=? AND status='accepted' AND fundi_id=?").get(job.id,userId) as {fundi_id:string}|undefined;
  const assignedWorker=db.prepare('SELECT worker_id FROM assignments WHERE job_id=? AND worker_id=?').get(job.id,userId) as {worker_id:string}|undefined;
  const isConnected=userId===job.foreman_id||Boolean(acceptedApplicant)||Boolean(assignedWorker);
  if(!isConnected)return {valid:false,reason:'You are not connected to that job.'};
  const inferred = userId===job.foreman_id ? (assignedWorker?.worker_id || acceptedApplicant?.fundi_id || '') : job.foreman_id;
  if(other && other!==inferred) return {valid:false,reason:'The other party does not match the job.'};
  return {valid:true,otherPartyId:inferred||'',jobId:job.id};
 }
 if(other){
  const party = db.prepare('SELECT id FROM users WHERE id=?').get(other) as {id:string}|undefined;
  if(!party)return {valid:false,reason:'The other party was not found.'};
  return {valid:true,otherPartyId:other};
 }
 return {valid:false,reason:'Provide a valid job or assignment reference.'};
}
function disputeForUser(disputeId:string,user:NonNullable<AuthedRequest['user']>){
 const row:any=db.prepare('SELECT * FROM disputes WHERE id=?').get(clean(disputeId,100));
 if(!row)return null;
 if(user.role==='administrator'||row.user_id===user.id||row.other_party_id===user.id||row.foreman_id===user.id)return sanitizeDisputeRow(row);
 const assignmentId=row.assignment_id||'';
 if(assignmentId){
  const assignment:any=db.prepare('SELECT foreman_id,worker_id FROM assignments WHERE id=?').get(assignmentId);
  if(assignment&&(assignment.foreman_id===user.id||assignment.worker_id===user.id))return sanitizeDisputeRow(row);
 }
 const jobId=row.job_id||'';
 if(jobId){
  const job:any=db.prepare('SELECT foreman_id FROM jobs WHERE id=?').get(jobId);
  const acceptedApplicant=db.prepare("SELECT fundi_id FROM applications WHERE job_id=? AND status='accepted' AND fundi_id=?").get(jobId,user.id) as {fundi_id:string}|undefined;
  const assignedWorker=db.prepare('SELECT worker_id FROM assignments WHERE job_id=? AND worker_id=?').get(jobId,user.id) as {worker_id:string}|undefined;
  if(job&&(job.foreman_id===user.id||Boolean(acceptedApplicant)||Boolean(assignedWorker)))return sanitizeDisputeRow(row);
 }
 return null;
}
app.get('/api/notifications',auth,(req:AuthedRequest,res)=>{
 const notifications=db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC').all(req.user!.id);
 res.json({notifications,unreadCount:notifications.filter((n:any)=>!Number(n.read)).length});
});
app.patch('/api/notifications/:id/read',auth,(req:AuthedRequest,res)=>{
 const result=db.prepare('UPDATE notifications SET read=1 WHERE id=? AND user_id=?').run(req.params.id,req.user!.id);
 if(!result.changes)return res.status(404).json({error:'Notification not found.'});
 res.json({ok:true});
});
app.patch('/api/notifications/read-all',auth,(req:AuthedRequest,res)=>{
 db.prepare('UPDATE notifications SET read=1 WHERE user_id=?').run(req.user!.id);
 res.json({ok:true});
});
app.get('/api/notifications/unread-count',auth,(req:AuthedRequest,res)=>{
 const record=(db.prepare('SELECT COUNT(*) AS count FROM notifications WHERE user_id=? AND read=0').get(req.user!.id) as {count:number});
 res.json({count:record.count});
});
app.post('/api/disputes',auth,(req:AuthedRequest,res)=>{
 const subject=clean(req.body.subject,150);
 const details=clean(req.body.details,2000);
 const category=clean(req.body.category,80)||'general';
 const jobId=clean(req.body.jobId || req.body.job_id,100);
 const assignmentId=clean(req.body.assignmentId || req.body.assignment_id,100);
 const otherPartyId=clean(req.body.otherPartyId || req.body.other_party_id,100);
 if(!subject||!details)return res.status(400).json({error:'A subject and explanation are required.'});
 const link=connectedDisputeParticipant(jobId||undefined,assignmentId||undefined,req.user!.id,otherPartyId);
 if(!link.valid)return res.status(400).json({error:link.reason});
 const relatedJobId=jobId||link.jobId||'';
 const relatedAssignmentId=assignmentId||'';
 const disputeId=id();
 const nowIso=now();
 const created=db.transaction(()=>{
  const existing=db.prepare(`SELECT id FROM disputes WHERE user_id=? AND status IN ('open','under_review') AND subject=? AND details=? AND COALESCE(job_id,'')=? AND COALESCE(assignment_id,'')=? LIMIT 1`)
   .get(req.user!.id,subject,details,relatedJobId,relatedAssignmentId);
  if(existing)return false;
  db.prepare(`INSERT INTO disputes (id,user_id,other_party_id,foreman_id,subject,details,record_id,job_id,assignment_id,category,status,created_at,updated_at,resolution_note,admin_id,admin_name)
   VALUES (?,?,NULLIF(?,''),NULLIF(?,''),?,?,?,NULLIF(?,''),NULLIF(?,''),?,?,?,?,?,NULLIF(?,''),?)`)
   .run(disputeId,req.user!.id,link.otherPartyId||otherPartyId,link.otherPartyId===req.user!.id?'':(link.otherPartyId||otherPartyId),subject,details,'',relatedJobId,relatedAssignmentId,category,'open',nowIso,nowIso,'','', '');
  notify(req.user!.id,'Dispute received','Your dispute has been submitted for review.',{link:`/disputes/${disputeId}`});
  if(link.otherPartyId && link.otherPartyId!==req.user!.id){
   notify(link.otherPartyId,'New dispute raised','A new dispute has been raised about your work relationship.',{link:`/disputes/${disputeId}`});
  }
  audit(req.user!.id,'dispute.created',disputeId,`${category} • ${subject}`);
  return true;
 }).immediate();
 if(!created)return res.status(409).json({error:'A similar dispute is already open for this matter.'});
 const dispute=sanitizeDisputeRow(db.prepare('SELECT * FROM disputes WHERE id=?').get(disputeId));
 res.status(201).json({id:disputeId,dispute});
});
app.get('/api/disputes',auth,(req:AuthedRequest,res)=>{
 const user=req.user!;
 const rows=user.role==='administrator'
  ?db.prepare('SELECT * FROM disputes ORDER BY created_at DESC').all()
  :db.prepare('SELECT * FROM disputes WHERE user_id=? OR other_party_id=? OR foreman_id=? ORDER BY created_at DESC').all(user.id,user.id,user.id);
 res.json({disputes:rows.map((row:any)=>sanitizeDisputeRow(row)).filter(Boolean)});
});
app.get('/api/disputes/:id',auth,(req:AuthedRequest,res)=>{
 const dispute=disputeForUser(clean(req.params.id,100),req.user!);
 if(!dispute)return res.status(404).json({error:'Dispute not found or access denied.'});
 const responses=db.prepare('SELECT * FROM dispute_responses WHERE dispute_id=? ORDER BY created_at DESC').all(dispute.id);
 const history=db.prepare("SELECT id,user_id,action,target,details,created_at FROM audit_logs WHERE target=? AND action LIKE 'dispute.%' ORDER BY created_at DESC").all(dispute.id);
 res.json({dispute,responses,history});
});
app.post('/api/disputes/:id/respond',auth,(req:AuthedRequest,res)=>{
 const dispute=disputeForUser(clean(req.params.id,100),req.user!);
 if(!dispute)return res.status(404).json({error:'Dispute not found or access denied.'});
 if(req.user!.id!==dispute.user_id&&req.user!.id!==dispute.other_party_id) return res.status(403).json({error:'Only the involved parties can respond to this dispute.'});
 if(['resolved','rejected','closed'].includes(dispute.status))return res.status(409).json({error:'This dispute is already closed to additional responses.'});
 const message=clean(req.body.message,2000);
 if(!message)return res.status(400).json({error:'A response message is required.'});
 const responseId=id();
 const createdAt=now();
 const responseResult=db.transaction(()=>{
  const current:any=db.prepare('SELECT user_id,other_party_id,status FROM disputes WHERE id=?').get(dispute.id);
  if(!current|| (req.user!.id!==current.user_id&&req.user!.id!==current.other_party_id))return 'forbidden' as const;
  const currentStatus=normalizeDisputeStatus(current.status);
  if(['resolved','rejected','closed'].includes(currentStatus))return 'closed' as const;
  const nextStatus=currentStatus==='open'?'under_review':currentStatus;
  db.prepare('INSERT INTO dispute_responses (id,dispute_id,user_id,message,created_at) VALUES (?,?,?,?,?)')
   .run(responseId,dispute.id,req.user!.id,message,createdAt);
  db.prepare('UPDATE disputes SET status=?,updated_at=? WHERE id=?').run(nextStatus,createdAt,dispute.id);
  const recipient=req.user!.id===current.user_id?current.other_party_id:current.user_id;
  if(recipient)notify(recipient,'Dispute response received','A response has been added to an active dispute.',{link:`/disputes/${dispute.id}`});
  audit(req.user!.id,'dispute.response',dispute.id,message);
  return 'created' as const;
 }).immediate();
 if(responseResult==='forbidden')return res.status(403).json({error:'Only the involved parties can respond to this dispute.'});
 if(responseResult==='closed')return res.status(409).json({error:'This dispute is already closed to additional responses.'});
 res.status(201).json({id:responseId,response:{id:responseId,dispute_id:dispute.id,user_id:req.user!.id,message,created_at:createdAt}});
});
app.patch('/api/disputes/:id/status',auth,roles('administrator'),(req:AuthedRequest,res)=>{
 const disputeRecord:any=db.prepare('SELECT * FROM disputes WHERE id=?').get(clean(req.params.id,100));
 if(!disputeRecord)return res.status(404).json({error:'Dispute not found.'});
 const requestedStatus=String(req.body.status??'').trim().toLowerCase().replace(/[_\s-]+/g,'_');
 if(!['open','under_review','resolved','rejected','closed'].includes(requestedStatus))return res.status(400).json({error:'Choose a valid dispute status.'});
 const next=normalizeDisputeStatus(req.body.status);
 const validTransitions:Record<string,string[]>={
  open:['open','under_review','rejected','closed'],
  under_review:['under_review','resolved','rejected','closed'],
  resolved:['resolved','closed'],
  rejected:['rejected','closed'],
  closed:['closed']
 };
 const note=clean(req.body.resolutionNote || req.body.reason || req.body.details || '',2000);
 const updatedAt=now();
 const resolution=db.transaction(()=>{
  const currentRecord:any=db.prepare('SELECT status,user_id,other_party_id FROM disputes WHERE id=?').get(disputeRecord.id);
  if(!currentRecord)return 'missing' as const;
  const current=normalizeDisputeStatus(currentRecord.status);
  if(!validTransitions[current]?.includes(next))return 'invalid' as const;
  db.prepare('UPDATE disputes SET status=?,updated_at=?,resolution_note=?,admin_id=?,admin_name=? WHERE id=?')
   .run(next,updatedAt,note,req.user!.id,req.user!.name,disputeRecord.id);
  const recipientIds=[currentRecord.user_id,currentRecord.other_party_id].filter(Boolean);
  for(const partyId of recipientIds){
   if(partyId!==req.user!.id)notify(partyId,'Dispute status updated',`Your dispute is now ${disputeStatusLabel(next)}.`,{link:`/disputes/${disputeRecord.id}`});
  }
  audit(req.user!.id,'dispute.status',disputeRecord.id,`${current} -> ${next}${note?` | ${note}`:''}`);
  return 'updated' as const;
 }).immediate();
 if(resolution==='missing')return res.status(404).json({error:'Dispute not found.'});
 if(resolution==='invalid')return res.status(409).json({error:'That dispute status transition is not allowed.'});
 const updated=sanitizeDisputeRow(db.prepare('SELECT * FROM disputes WHERE id=?').get(disputeRecord.id));
 res.json({dispute:updated});
});
app.get('/api/admin/overview',auth,roles('administrator'),(req,res)=>{
 const integerParameter=(value:unknown,fallback:number)=>{
  if(value===undefined)return fallback;
  if(typeof value!=='string'||!/^\d+$/.test(value))return null;
  const parsed=Number(value);
  return Number.isSafeInteger(parsed)?parsed:null;
 };
 const limit=integerParameter(req.query.limit,25);
 const offset=integerParameter(req.query.offset,0);
 if(limit===null||limit<1||limit>100||offset===null||offset>1_000_000){
  return res.status(400).json({error:'Audit pagination requires limit 1–100 and offset 0–1000000.'});
 }
 const metrics=getAdminDashboardMetrics(db);
 const auditPage=getRecentAdminAuditLogs(db,limit,offset);
 res.json({
  users:metrics.users.total,
  jobs:metrics.jobs.total,
  pendingEvidence:metrics.evidence.pending,
  openDisputes:metrics.disputes.pending,
  metrics,
  auditLogs:auditPage.logs,
  total:auditPage.total,
  limit:auditPage.limit,
  offset:auditPage.offset,
 });
});
app.use('/api',(req,res)=>res.status(404).json({error:`API route not found: ${req.method} ${req.path}`}));
if (!developmentMode) {
 app.use(express.static(clientBuildDir));
 app.use((req,res,next)=>{
  if(req.method!=='GET'||req.path.startsWith('/api/'))return next();
  res.sendFile(clientIndexFile,(error)=>{if(error)next(error);});
 });
}
app.use((err:any,_req:Request,res:Response,_next:NextFunction)=>{
 if(err instanceof SyntaxError&&'status' in err&&err.status===400){
  return res.status(400).json({error:'Request body contains invalid JSON.'});
 }
 if(err instanceof multer.MulterError){
  if(err.code==='LIMIT_FILE_SIZE')return res.status(413).json({error:'Evidence files must be 5 MB or smaller.'});
  console.error(err);
  return res.status(400).json({error:'The uploaded file could not be processed.'});
 }
 if(err instanceof UnsupportedEvidenceTypeError)return res.status(415).json({error:err.message});
 console.error(err);
 res.status(500).json({error:'Unexpected server error.'});
});
app.listen(port,'0.0.0.0',()=>{
 console.log(`FundiConnect API running at http://localhost:${port}`);
 console.info(`[startup] pid=${process.pid} NODE_ENV=${process.env.NODE_ENV} DATABASE_FILE=${databaseFile} CLIENT_ORIGIN=${allowedClientOrigin}`);
});
