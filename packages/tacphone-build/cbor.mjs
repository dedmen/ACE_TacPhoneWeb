// Minimal CBOR decoder for the stringtable dataset.
//
// Only the types that appear in BrettMayson's `strings.cbor` are supported:
// definite and indefinite maps/arrays/text/byte strings, unsigned integers and
// simple values. Anything else is rejected instead of being guessed.

/** Decodes one CBOR document from `buffer`. */
export function decodeCbor(buffer) {
    let offset = 0

    const readUint = (size) => {
        let value = 0

        for (let index = 0; index < size; index += 1)
            value = value * 256 + buffer[offset++]

        return value
    }

    const readLength = (additional) => {
        if (additional < 24)
            return additional
        if (additional === 24)
            return readUint(1)
        if (additional === 25)
            return readUint(2)
        if (additional === 26)
            return readUint(4)
        if (additional === 27)
            return readUint(8)
        if (additional === 31)
            return -1

        throw new Error(`Unsupported CBOR additional info ${additional}`)
    }

    const readItem = () => {
        const initial = buffer[offset++]
        if (initial === undefined)
            throw new Error('Unexpected end of CBOR data')

        const major = initial >> 5
        const additional = initial & 31
        const length = readLength(additional)

        switch (major) {
            case 0: return length
            case 1: return -1 - length

            case 2: {
                if (length === -1) {
                    const chunks = []
                    while (buffer[offset] !== 0xff)
                        chunks.push(readItem())
                    offset += 1
                    return Buffer.concat(chunks)
                }

                const value = buffer.subarray(offset, offset + length)
                offset += length
                return value
            }

            case 3: {
                if (length === -1) {
                    let text = ''
                    while (buffer[offset] !== 0xff)
                        text += readItem()
                    offset += 1
                    return text
                }

                const value = buffer.toString('utf8', offset, offset + length)
                offset += length
                return value
            }

            case 4: {
                const values = []
                if (length === -1) {
                    while (buffer[offset] !== 0xff)
                        values.push(readItem())
                    offset += 1
                } else {
                    for (let index = 0; index < length; index += 1)
                        values.push(readItem())
                }
                return values
            }

            case 5: {
                const map = Object.create(null)
                if (length === -1) {
                    while (buffer[offset] !== 0xff) {
                        const key = readItem()
                        map[key] = readItem()
                    }
                    offset += 1
                } else {
                    for (let index = 0; index < length; index += 1) {
                        const key = readItem()
                        map[key] = readItem()
                    }
                }
                return map
            }

            case 6:
                return readItem()

            case 7:
                if (additional === 20) return false
                if (additional === 21) return true
                if (additional === 22 || additional === 23) return null
                return null

            default:
                throw new Error(`Unsupported CBOR major type ${major}`)
        }
    }

    return readItem()
}
