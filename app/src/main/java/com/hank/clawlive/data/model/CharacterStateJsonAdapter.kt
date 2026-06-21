package com.hank.clawlive.data.model

import com.google.gson.JsonDeserializationContext
import com.google.gson.JsonDeserializer
import com.google.gson.JsonElement
import com.google.gson.JsonPrimitive
import com.google.gson.JsonSerializationContext
import com.google.gson.JsonSerializer
import java.lang.reflect.Type

class CharacterStateJsonAdapter : JsonDeserializer<CharacterState>, JsonSerializer<CharacterState> {
    override fun deserialize(
        json: JsonElement?,
        typeOfT: Type?,
        context: JsonDeserializationContext?
    ): CharacterState {
        if (json == null || json.isJsonNull || !json.isJsonPrimitive) {
            return CharacterState.IDLE
        }
        return CharacterState.fromWireValue(json.asString)
    }

    override fun serialize(
        src: CharacterState?,
        typeOfSrc: Type?,
        context: JsonSerializationContext?
    ): JsonElement {
        return JsonPrimitive((src ?: CharacterState.IDLE).serverValue)
    }
}
