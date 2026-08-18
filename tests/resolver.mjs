export async function resolve(spec, ctx, next) {
  try { return await next(spec, ctx); }
  catch (e) {
    if (spec.startsWith('.')) return next(spec + '.js', ctx);
    throw e;
  }
}
