-- Ejecutar una sola vez en Supabase > SQL Editor.
-- Elimina exclusivamente el vendedor con username = 'prueba'
-- y todos sus productos, ventas y detalles asociados.

do $$
declare
  v_vendedor_id uuid;
begin
  select id into v_vendedor_id
  from public.usuarios
  where username = 'prueba' and rol = 'vendedor';

  if v_vendedor_id is null then
    raise notice 'No existe el vendedor prueba.';
    return;
  end if;

  delete from public.venta_items
  where venta_id in (
    select id from public.ventas where vendedor_id = v_vendedor_id
  );

  delete from public.ventas
  where vendedor_id = v_vendedor_id;

  delete from public.productos
  where vendedor_id = v_vendedor_id;

  delete from public.usuarios
  where id = v_vendedor_id;

  raise notice 'Vendedor prueba y sus datos fueron eliminados.';
end;
$$;
