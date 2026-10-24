-- TRAMO 7. Revisar y aplicar manualmente. Todas las mutaciones toman el mismo
-- advisory lock transaccional; sólo service_role puede ejecutar estas RPC.

create or replace function public.consultorio_agenda_listar(p_desde timestamptz,p_hasta timestamptz)
returns jsonb language sql stable security definer set search_path to '' as $$
 select jsonb_build_object(
  'turnos',coalesce((select jsonb_agg(to_jsonb(t)) from consultorio.turnos t where (t.estado<>'cancelado' and t.en_origen is not false) and t.inicio<p_hasta and t.fin>p_desde),'[]'::jsonb),
  'bloqueos',coalesce((select jsonb_agg(to_jsonb(b)) from consultorio.bloqueos b where b.en_origen is not false and b.inicio<p_hasta and b.fin>p_desde),'[]'::jsonb));
$$;

create or replace function public.consultorio_agenda_proximo_bloqueo(p_desde timestamptz,p_hasta timestamptz)
returns table(date text) language sql stable security definer set search_path to '' as $$
 select to_char((b.inicio at time zone 'UTC' - interval '3 hours')::date,'YYYY-MM-DD') from consultorio.bloqueos b
 where b.en_origen is not false and b.clase='bloqueo' and b.dia_completo and b.inicio>=p_desde and b.inicio<p_hasta order by b.inicio limit 1;
$$;
create or replace function public.consultorio_agenda_por_codigo(p_codigo text)
returns setof consultorio.turnos language sql stable security definer set search_path to '' as $$
 select t.* from consultorio.turnos t where upper(t.codigo_corto)=upper(p_codigo) and (t.estado<>'cancelado' and t.en_origen is not false) limit 1;
$$;
create or replace function public.consultorio_agenda_por_id(p_id text)
returns setof consultorio.turnos language sql stable security definer set search_path to '' as $$
 select t.* from consultorio.turnos t where t.id::text=p_id or t.calendar_event_id=p_id limit 1;
$$;

create or replace function public.consultorio_agenda_asegurar_codigo(p jsonb)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare t consultorio.turnos%rowtype; c text;
begin
 perform pg_advisory_xact_lock(hashtextextended('consultorio.agenda',0));
 select * into t from consultorio.turnos where (id::text=p->>'id' or calendar_event_id=p->>'id') and estado<>'cancelado' and en_origen is not false for update;
 if not found then return jsonb_build_object('ok',false); end if;
 c:=coalesce(nullif(t.codigo_corto,''),p->>'codigo_corto');
 update consultorio.turnos set codigo_corto=c,description_original=case when coalesce(description_original,'') ilike '%Código corto:%' then description_original else concat_ws(E'\n',nullif(rtrim(coalesce(description_original,'')),''),'Código corto: '||c) end,calendar_updated=now(),sincronizado_en=now() where id=t.id returning * into t;
 return jsonb_build_object('ok',true,'codigo_corto',c,'turno',to_jsonb(t));
end $$;

create or replace function public.consultorio_agenda_crear_turno(p jsonb)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_id uuid; s timestamptz:=(p->>'inicio')::timestamptz; e timestamptz:=(p->>'fin')::timestamptz; ty text:=coalesce(p->>'tipo','turno');
begin
 perform pg_advisory_xact_lock(hashtextextended('consultorio.agenda',0));
 if e<=s then return jsonb_build_object('ok',false,'error','rango_invalido'); end if;
 -- Un reintento idéntico tras perder la respuesta devuelve el UUID creado.
 select t.id into v_id from consultorio.turnos t where (t.estado<>'cancelado' and t.en_origen is not false) and t.inicio=s and t.fin=e and t.tipo=ty
   and lower(coalesce(t.paciente_nombre,''))=lower(coalesce(p->>'paciente_nombre',''))
   and coalesce(t.telefono,'')=coalesce(p->>'telefono','') limit 1;
 if v_id is not null then return jsonb_build_object('ok',true,'id',v_id,'codigo_corto',(select codigo_corto from consultorio.turnos where id=v_id),'repetido',true); end if;
 if exists(select 1 from consultorio.bloqueos b where b.en_origen is not false and b.inicio<e and b.fin>s) then return jsonb_build_object('ok',false,'error','bloqueado'); end if;
 if exists(select 1 from consultorio.turnos t where (t.estado<>'cancelado' and t.en_origen is not false) and t.inicio<e and t.fin>s and not ((ty='sobreturno' and t.tipo='turno') or (ty='turno' and t.tipo='sobreturno'))) then return jsonb_build_object('ok',false,'error','ocupado'); end if;
 insert into consultorio.turnos(calendar_event_id,paciente_id,inicio,fin,motivo,estado,calendar_id,tipo,paciente_nombre,dni,telefono,email,paciente_nuevo,telefono_verificado,confirmado,confirmacion_solicitada,codigo_corto,ubicacion,description_original,en_origen,calendar_updated,sincronizado_en)
 values(null,null,s,e,p->>'motivo',case when coalesce((p->>'confirmado')::boolean,false) then 'confirmado' else 'pendiente' end,p->>'calendar_id',ty,p->>'paciente_nombre',p->>'dni',p->>'telefono',p->>'email',coalesce((p->>'paciente_nuevo')::boolean,false),coalesce((p->>'telefono_verificado')::boolean,false),coalesce((p->>'confirmado')::boolean,false),coalesce((p->>'confirmacion_solicitada')::boolean,false),p->>'codigo_corto',p->>'ubicacion',p->>'description_original',true,now(),now()) returning id into v_id;
 return jsonb_build_object('ok',true,'id',v_id,'codigo_corto',p->>'codigo_corto');
end $$;

create or replace function public.consultorio_agenda_cancelar(p jsonb)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare t consultorio.turnos%rowtype;
begin
 perform pg_advisory_xact_lock(hashtextextended('consultorio.agenda',0));
 select * into t from consultorio.turnos where id::text=p->>'id' or calendar_event_id=p->>'id' for update;
 if not found or t.estado='cancelado' or t.en_origen is false then return jsonb_build_object('ok',false); end if;
 update consultorio.turnos set estado='cancelado',calendar_updated=now(),sincronizado_en=now() where id=t.id;
 return jsonb_build_object('ok',true,'id',t.id,'calendar_id',t.calendar_id,'calendar_event_id',t.calendar_event_id);
end $$;
create or replace function public.consultorio_agenda_confirmar(p jsonb)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare t consultorio.turnos%rowtype;
begin
 update consultorio.turnos set confirmado=coalesce((p->>'confirmado')::boolean,true),estado=case when estado='pendiente' and coalesce((p->>'confirmado')::boolean,true) then 'confirmado' else estado end,calendar_updated=now(),sincronizado_en=now() where (id::text=p->>'id' or calendar_event_id=p->>'id') and estado<>'cancelado' and en_origen is not false returning * into t;
 if not found then return jsonb_build_object('ok',false); end if; return jsonb_build_object('ok',true,'id',t.id,'turno',to_jsonb(t));
end $$;
create or replace function public.consultorio_agenda_confirmacion_solicitada(p jsonb)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare n integer;
begin update consultorio.turnos set confirmacion_solicitada=true,calendar_updated=now(),sincronizado_en=now() where (id::text=p->>'id' or calendar_event_id=p->>'id') and estado<>'cancelado' and en_origen is not false; get diagnostics n=row_count; return jsonb_build_object('ok',n>0); end $$;

create or replace function public.consultorio_agenda_mover(p jsonb)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare t consultorio.turnos%rowtype; s timestamptz:=(p->>'inicio')::timestamptz; e timestamptz:=(p->>'fin')::timestamptz; v_calendar_anterior text; v_evento_anterior text; v_tipo text;
begin
 perform pg_advisory_xact_lock(hashtextextended('consultorio.agenda',0));
 select * into t from consultorio.turnos where (id::text=p->>'id' or calendar_event_id=p->>'id') and estado<>'cancelado' and en_origen is not false for update;
 if not found then return jsonb_build_object('ok',false); end if;
 v_calendar_anterior:=t.calendar_id;
 v_evento_anterior:=t.calendar_event_id;
 v_tipo:=case when coalesce((p->>'mantener_tipo')::boolean,false) then t.tipo else 'turno' end;
 if exists(select 1 from consultorio.bloqueos b where b.en_origen is not false and b.inicio<e and b.fin>s) or exists(select 1 from consultorio.turnos x where x.id<>t.id and (x.estado<>'cancelado' and x.en_origen is not false) and x.inicio<e and x.fin>s and not ((v_tipo='sobreturno' and x.tipo='turno') or (v_tipo='turno' and x.tipo='sobreturno'))) then return jsonb_build_object('ok',false,'error','ocupado'); end if;
 update consultorio.turnos set inicio=s,fin=e,tipo=case when coalesce((p->>'mantener_tipo')::boolean,false) then t.tipo else 'turno' end,calendar_id=coalesce(p->>'calendar_id',calendar_id),calendar_event_id=case when coalesce(p->>'calendar_id',calendar_id) is distinct from v_calendar_anterior then null else calendar_event_id end,paciente_nombre=coalesce(p->>'paciente_nombre',paciente_nombre),motivo=coalesce(p->>'motivo',motivo),calendar_updated=now(),sincronizado_en=now() where id=t.id;
 select * into t from consultorio.turnos where id=t.id;
 return jsonb_build_object('ok',true,'id',t.id,'codigo_corto',t.codigo_corto,'calendar_anterior',v_calendar_anterior,'calendar_event_id_anterior',v_evento_anterior,'turno',to_jsonb(t));
end $$;
create or replace function public.consultorio_agenda_editar(p jsonb)
returns jsonb language plpgsql security definer set search_path to '' as $$ begin return public.consultorio_agenda_mover(p); end $$;

create or replace function public.consultorio_agenda_crear_bloqueo(p jsonb)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_id uuid; s timestamptz:=(p->>'inicio')::timestamptz; e timestamptz:=(p->>'fin')::timestamptz; c text:=coalesce(p->>'clase','bloqueo');
begin
 perform pg_advisory_xact_lock(hashtextextended('consultorio.agenda',0));
 if exists(select 1 from consultorio.bloqueos b where b.en_origen is not false and b.clase=c and b.inicio<e and b.fin>s) then return jsonb_build_object('ok',true,'id',null); end if;
 if c='bloqueo' and exists(select 1 from consultorio.turnos t where (t.estado<>'cancelado' and t.en_origen is not false) and t.inicio<e and t.fin>s) then return jsonb_build_object('ok',false,'error','hay_turnos'); end if;
 insert into consultorio.bloqueos(calendar_id,calendar_event_id,clase,inicio,fin,dia_completo,motivo,en_origen,sincronizado_en) values(p->>'calendar_id',null,c,s,e,coalesce((p->>'dia_completo')::boolean,false),p->>'motivo',true,now()) returning id into v_id;
 return jsonb_build_object('ok',true,'id',v_id);
end $$;
create or replace function public.consultorio_agenda_borrar_bloqueo(p jsonb)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare n integer; d timestamptz:=((p->>'fecha')||'T00:00:00-03:00')::timestamptz; ev jsonb;
begin
 perform pg_advisory_xact_lock(hashtextextended('consultorio.agenda',0));
 select coalesce(jsonb_agg(jsonb_build_object('calendar_id',calendar_id,'calendar_event_id',calendar_event_id)),'[]'::jsonb) into ev from consultorio.bloqueos where clase=p->>'clase' and dia_completo and inicio>=d and inicio<d+interval '1 day';
 delete from consultorio.bloqueos where clase=p->>'clase' and dia_completo and inicio>=d and inicio<d+interval '1 day'; get diagnostics n=row_count; return jsonb_build_object('ok',n>0,'eventos',ev);
end $$;

create or replace function public.consultorio_agenda_guardar_calendar_id(p jsonb)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare n integer;
begin update consultorio.turnos set calendar_event_id=p->>'calendar_event_id',sincronizado_en=now() where id::text=p->>'id'; get diagnostics n=row_count;
 if n=0 then update consultorio.bloqueos set calendar_event_id=p->>'calendar_event_id',sincronizado_en=now() where id::text=p->>'id'; get diagnostics n=row_count; end if; return jsonb_build_object('ok',n>0); end $$;
create or replace function public.consultorio_agenda_guardar_bloqueo_calendar_id(p jsonb)
returns jsonb language plpgsql security definer set search_path to '' as $$declare n integer; begin update consultorio.bloqueos set calendar_event_id=p->>'calendar_event_id',sincronizado_en=now() where id::text=p->>'id'; get diagnostics n=row_count; return jsonb_build_object('ok',n>0); end $$;

do $$ declare f record; begin for f in select p.oid::regprocedure as firma from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'consultorio_agenda_%' loop
 execute format('revoke all on function %s from public, anon, authenticated',f.firma); execute format('grant execute on function %s to service_role',f.firma); end loop; end $$;
