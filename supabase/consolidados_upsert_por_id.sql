-- 2026-11-26: el upsert de consolidados acepta `id` para escribir EXACTAMENTE esa fila.
-- Motivo: al asignar a mano una persona sin DNI (p. ej. una fila "solo turno") a una ficha,
-- la búsqueda por ficha_id encontraba primero la fila propia de la ficha y actualizaba esa,
-- así que la persona seguía apareciendo "sin ficha" en /admin. Sin `id` el comportamiento
-- es el de siempre (DNI, después ficha, después teléfono).
CREATE OR REPLACE FUNCTION public.consultorio_consolidados_upsert(p_fila jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v consultorio.consolidados%rowtype; d text:=regexp_replace(coalesce(p_fila->>'dni',''),'\D','','g'); t text:=regexp_replace(coalesce(p_fila->>'telefono',''),'\D','','g'); fid text:=coalesce(p_fila->>'fichaId',''); vid text:=coalesce(p_fila->>'id','');
begin
 perform pg_advisory_xact_lock(hashtextextended('consultorio.consolidados',0));
 if vid<>'' then
  select * into v from consultorio.consolidados c where c.id::text=vid limit 1 for update;
 end if;
 if v.id is null then
  select * into v from consultorio.consolidados c
   where (d<>'' and c.dni_norm=d)
      or (fid<>'' and c.ficha_id=fid)
      or (d='' and t<>'' and length(t)>=8 and right(regexp_replace(c.telefono,'\D','','g'),10)=right(t,10))
   order by (d<>'' and c.dni_norm=d) desc, (fid<>'' and c.ficha_id=fid) desc limit 1 for update;
 end if;
 if v.id is not null then
  update consultorio.consolidados set telefono=coalesce(nullif(p_fila->>'telefono',''),telefono), nombre=coalesce(nullif(p_fila->>'nombre',''),nombre), apellido=coalesce(nullif(p_fila->>'apellido',''),apellido), dni=coalesce(nullif(p_fila->>'dni',''),dni), ficha_id=coalesce(nullif(fid,''),ficha_id), origen=case when fid<>'' then 'ficha' else origen end, email=coalesce(nullif(p_fila->>'email',''),email), actualizado=now() where id=v.id returning * into v;
 else
  insert into consultorio.consolidados(telefono,nombre,apellido,dni,ficha_id,origen,email) values(coalesce(p_fila->>'telefono',''),coalesce(p_fila->>'nombre',''),coalesce(p_fila->>'apellido',''),coalesce(p_fila->>'dni',''),fid,coalesce(nullif(p_fila->>'origen',''),'turno'),coalesce(p_fila->>'email','')) returning * into v;
 end if;
 return jsonb_build_object('ok',true,'fila',to_jsonb(v));
end $function$;
