// Reads and checks the pages' JSON request before it can spend a model call.
// Returns { report, neighborhood, assessment?, photo? }, or { error: [status, code, message] }.
const maxRequestBytes = 64 * 1024
const maxPhotoSide = 1024

const invalid = (message = "Enter a report and neighborhood. Attach a small JPEG if needed.") => ({
  error: [400, "invalid_request", message],
})
const tooLarge = {
  error: [
    413,
    "payload_too_large",
    "The request or photo is too large. Use a smaller JPEG.",
    { connection: "close" },
  ],
}

const boundedText = (value, limit) => {
  const text = typeof value === "string" ? value.trim() : ""
  return text && text.length <= limit ? text : undefined
}

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value)

export const readInput = async (req, { withAssessment, maxPhotoBase64Chars }) => {
  const contentType = req.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase()
  const fetchSite = req.headers["sec-fetch-site"]
  if (contentType !== "application/json") return invalid()
  if (fetchSite && fetchSite !== "same-origin") return invalid()
  if (Number(req.headers["content-length"]) > maxRequestBytes) return tooLarge

  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.byteLength
    if (size > maxRequestBytes) return tooLarge
    chunks.push(chunk)
  }
  let body
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size)))
  } catch {
    return invalid()
  }
  const fields = ["report", "neighborhood", "photo", ...(withAssessment ? ["assessment"] : [])]
  if (!isObject(body) || Object.keys(body).some(key => !fields.includes(key))) return invalid()

  const input = {
    report: boundedText(body.report, 1200),
    neighborhood: boundedText(body.neighborhood, 100),
  }
  if (!input.report || !input.neighborhood) return invalid()
  if (withAssessment) {
    input.assessment = boundedText(body.assessment, 4000)
    if (!input.assessment) return invalid("Include the assessment before requesting more insights.")
  }
  if (body.photo === undefined) return input

  const { photo } = body
  const wellFormed =
    isObject(photo) &&
    Object.keys(photo).length === 2 &&
    photo.mediaType === "image/jpeg" &&
    typeof photo.image === "string"
  if (!wellFormed) return invalid()
  if (photo.image.length > maxPhotoBase64Chars) return tooLarge
  const image = Buffer.from(photo.image, "base64")
  if (!isSmallJpeg(image) || image.toString("base64") !== photo.image) return invalid()
  return { ...input, photo: photo.image }
}

// A baseline or progressive JPEG whose frame header fits the model's image limits, read without
// decoding it: start- and end-of-image markers, then segments up to the frame header (SOF0–SOF2).
const isSmallJpeg = image => {
  if (image.length < 4 || image.readUInt16BE(0) !== 0xffd8) return false
  if (image.readUInt16BE(image.length - 2) !== 0xffd9) return false
  let offset = 2
  while (offset + 4 <= image.length && image[offset] === 0xff) {
    const marker = image[offset + 1]
    if (marker === 0xff) {
      offset++
      continue
    }
    if (marker === 0xda || marker === 0xd9) return false
    const length = image.readUInt16BE(offset + 2)
    if (length < 2 || offset + 2 + length > image.length) return false
    if (marker >= 0xc0 && marker <= 0xc2) {
      if (length < 8) return false
      const sides = [image.readUInt16BE(offset + 5), image.readUInt16BE(offset + 7)]
      return sides.every(side => side > 0 && side <= maxPhotoSide)
    }
    offset += 2 + length
  }
  return false
}
