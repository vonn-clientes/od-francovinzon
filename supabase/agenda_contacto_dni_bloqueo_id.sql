-- Tramo 10. Revisar y aplicar manualmente; no se ejecuta desde el deploy.
-- Actualiza identidad y descripción del turno de forma atómica.
create or replace function public.consultorio_agenda_actualizar_contacto(p jsonb)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare t consultorio.turnos%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended('consultorio.agenda',0));
  update consultorio.turnos set
    dni=case when p ? 'dni' then nullif(p->>'dni','') else dni end,
    telefono=case when p ? 'telefono' then nullif(p->>'telefono','') else telefono end,
    description_original=coalesce(p->>'description_original',description_original),
    calendar_updated=now(), sincronizado_en=now()
  where (id::text=p->>'id' or calendar_event_id=p->>'id') and estado<>'cancelado' and en_origen is not false
  returning * into t;
  if not found then return jsonb_build_object('ok',false); end if;
  return jsonb_build_object('ok',true,'turno',to_jsonb(t));
end $$;

create or replace function public.consultorio_agenda_buscar_por_dni(p_dni text)
returns setof consultorio.turnos language sql stable security definer set search_path to '' as $$
 select t.* from consultorio.turnos t
 where regexp_replace(coalesce(t.dni,''),'\D','','g')=regexp_replace(coalesce(p_dni,''),'\D','','g')
   and t.estado<>'cancelado' and t.en_origen is not false
 order by t.inicio desc;
$$;

create or replace function public.consultorio_agenda_borrar_bloqueo(p jsonb)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare n integer; d timestamptz:=((p->>'fecha')||'T00:00:00-03:00')::timestamptz; ev jsonb;
begin
 perform pg_advisory_xact_lock(hashtextextended('consultorio.agenda',0));
 if p ? 'id' then
   select coalesce(jsonb_agg(jsonb_build_object('calendar_id',calendar_id,'calendar_event_id',calendar_event_id)),'[]'::jsonb) into ev from consultorio.bloqueos where id::text=p->>'id' and clase=coalesce(p->>'clase','bloqueo');
   delete from consultorio.bloqueos where id::text=p->>'id' and clase=coalesce(p->>'clase','bloqueo');
 else
   select coalesce(jsonb_agg(jsonb_build_object('calendar_id',calendar_id,'calendar_event_id',calendar_event_id)),'[]'::jsonb) into ev from consultorio.bloqueos where clase=p->>'clase' and dia_completo and inicio>=d and inicio<d+interval '1 day';
   delete from consultorio.bloqueos where clase=p->>'clase' and dia_completo and inicio>=d and inicio<d+interval '1 day';
 end if;
 get diagnostics n=row_count;
 return jsonb_build_object('ok',n>0,'eventos',ev);
end $$;

do $$ declare f record; begin for f in select p.oid::regprocedure as firma from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('consultorio_agenda_actualizar_contacto','consultorio_agenda_buscar_por_dni','consultorio_agenda_borrar_bloqueo') loop
 execute format('revoke all on function %s from public, anon, authenticated',f.firma); execute format('grant execute on function %s to service_role',f.firma); end loop; end $$;
