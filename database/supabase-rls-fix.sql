-- Ejecutar en Supabase > SQL Editor.
-- La aplicación usa la clave anon y una autenticación propia con la tabla usuarios.

alter table public.usuarios enable row level security;

drop policy if exists "usuarios lectura para acceso" on public.usuarios;
create policy "usuarios lectura para acceso"
on public.usuarios for select to anon using (true);

drop policy if exists "usuarios registro de vendedores" on public.usuarios;
create policy "usuarios registro de vendedores"
on public.usuarios for insert to anon
with check (rol = 'vendedor');

-- Usuario inicial de organización. Cambia esta contraseña después del primer acceso.
insert into public.usuarios (username, password_hash, nombre, rol)
select 'admin', 'ea368e4edd68511f5bea538bb638520a01986b73f43f9b21cd401a0dea0f3609', 'Organización del Festival', 'admin'
where not exists (select 1 from public.usuarios where username = 'admin');

alter table public.productos add column if not exists activo boolean not null default true;
update public.productos set activo = true where activo is null;
alter table public.productos enable row level security;

drop policy if exists "productos lectura publica de la app" on public.productos;
create policy "productos lectura publica de la app" on public.productos for select to anon using (true);
drop policy if exists "productos alta publica de la app" on public.productos;
create policy "productos alta publica de la app" on public.productos for insert to anon with check (true);
drop policy if exists "productos baja publica de la app" on public.productos;
create policy "productos baja publica de la app" on public.productos for delete to anon using (true);
drop policy if exists "productos retiro publico de la app" on public.productos;
create policy "productos retiro publico de la app" on public.productos for update to anon using (true) with check (true);

alter table public.ventas enable row level security;
drop policy if exists "ventas lectura publica de la app" on public.ventas;
create policy "ventas lectura publica de la app" on public.ventas for select to anon using (true);
drop policy if exists "ventas alta publica de la app" on public.ventas;
create policy "ventas alta publica de la app" on public.ventas for insert to anon with check (true);
drop policy if exists "ventas actualizacion publica de la app" on public.ventas;
create policy "ventas actualizacion publica de la app" on public.ventas for update to anon using (true) with check (true);

alter table public.venta_items enable row level security;
drop policy if exists "detalle ventas lectura publica de la app" on public.venta_items;
create policy "detalle ventas lectura publica de la app" on public.venta_items for select to anon using (true);
drop policy if exists "detalle ventas alta publica de la app" on public.venta_items;
create policy "detalle ventas alta publica de la app" on public.venta_items for insert to anon with check (true);
drop policy if exists "detalle ventas baja publica de la app" on public.venta_items;
create policy "detalle ventas baja publica de la app" on public.venta_items for delete to anon using (true);

create or replace function public.fn_guardar_registro_diario(
  p_vendedor_id uuid, p_fecha date, p_items jsonb,
  p_efectivo numeric, p_transferencia numeric
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_venta_id uuid;
  v_ingreso numeric := 0;
  v_ganancia numeric := 0;
  v_unidades numeric := 0;
  v_item jsonb;
begin
  for v_item in select value from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    v_ingreso := v_ingreso + ((v_item->>'unidades')::numeric * (v_item->>'precio_venta')::numeric);
    v_ganancia := v_ganancia + ((v_item->>'unidades')::numeric * (v_item->>'ganancia')::numeric);
    v_unidades := v_unidades + (v_item->>'unidades')::numeric;
  end loop;

  select id into v_venta_id from public.ventas
  where vendedor_id = p_vendedor_id and fecha = p_fecha limit 1;

  if v_venta_id is null then
    insert into public.ventas (vendedor_id, fecha, efectivo, transferencia, ingreso_total, ganancia_total, total_unidades)
    values (p_vendedor_id, p_fecha, p_efectivo, p_transferencia, v_ingreso, v_ganancia, v_unidades)
    returning id into v_venta_id;
  else
    update public.ventas set efectivo = p_efectivo, transferencia = p_transferencia,
      ingreso_total = v_ingreso, ganancia_total = v_ganancia, total_unidades = v_unidades
    where id = v_venta_id;
  end if;

  delete from public.venta_items where venta_id = v_venta_id;
  insert into public.venta_items (venta_id, producto_id, nombre_producto, unidades, precio_venta, ganancia)
  select v_venta_id, (item->>'producto_id')::uuid, item->>'nombre',
    (item->>'unidades')::numeric, (item->>'precio_venta')::numeric, (item->>'ganancia')::numeric
  from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) as items(item);

  return jsonb_build_object('venta_id', v_venta_id, 'ingreso_total', v_ingreso,
    'ganancia_total', v_ganancia, 'total_unidades', v_unidades);
end;
$$;
grant execute on function public.fn_guardar_registro_diario(uuid, date, jsonb, numeric, numeric) to anon;

create or replace function public.fn_eliminar_producto(p_producto_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_venta_ids uuid[];
  v_venta_id uuid;
begin
  select coalesce(array_agg(distinct venta_id), '{}'::uuid[]) into v_venta_ids
  from public.venta_items where producto_id = p_producto_id;
  delete from public.venta_items where producto_id = p_producto_id;

  foreach v_venta_id in array v_venta_ids loop
    if exists (select 1 from public.venta_items where venta_id = v_venta_id) then
      update public.ventas set
        ingreso_total = coalesce((select sum(unidades * precio_venta) from public.venta_items where venta_id = v_venta_id), 0),
        ganancia_total = coalesce((select sum(unidades * ganancia) from public.venta_items where venta_id = v_venta_id), 0),
        total_unidades = coalesce((select sum(unidades) from public.venta_items where venta_id = v_venta_id), 0)
      where id = v_venta_id;
    else
      delete from public.ventas where id = v_venta_id;
    end if;
  end loop;
  delete from public.productos where id = p_producto_id;
  return jsonb_build_object('producto_id', p_producto_id, 'eliminado', true);
end;
$$;
grant execute on function public.fn_eliminar_producto(uuid) to anon;

create or replace function public.fn_eliminar_historial_vendedor(p_vendedor_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_venta_ids uuid[];
begin
  select coalesce(array_agg(id), '{}'::uuid[]) into v_venta_ids
  from public.ventas where vendedor_id = p_vendedor_id;
  delete from public.venta_items where venta_id = any(v_venta_ids);
  delete from public.ventas where vendedor_id = p_vendedor_id;
  return jsonb_build_object('vendedor_id', p_vendedor_id, 'eliminados', cardinality(v_venta_ids));
end;
$$;
grant execute on function public.fn_eliminar_historial_vendedor(uuid) to anon;
