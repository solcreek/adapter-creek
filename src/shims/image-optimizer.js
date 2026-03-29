// Image optimization shim for CF Workers.
// Delegates to Cloudflare Image Resizing instead of sharp.
// See: https://developers.cloudflare.com/images/transform-images/

export async function optimizeImage(buffer, { width, height, quality, contentType }) {
  // CF Image Resizing is handled at the edge via cf.image options
  // on fetch requests. For the adapter, we return the original image
  // since optimization happens at the CDN layer, not in the worker.
  //
  // In production, the dispatch worker or CDN rules apply:
  //   fetch(imageUrl, { cf: { image: { width, height, quality, format } } })
  return {
    buffer,
    contentType: contentType || "image/webp",
  };
}

export default { optimizeImage };
