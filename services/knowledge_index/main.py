"""Private hybrid-search vector index for ShengYue documents.

The service owns no browser-facing routes. It receives already-authorized,
structured chunks from the Worker and applies tenant/user filters to every
vector query before returning passages.
"""

from __future__ import annotations

import os
import uuid
from functools import lru_cache
from typing import Any

from fastapi import FastAPI, HTTPException
from fastembed import TextEmbedding
from pydantic import BaseModel, Field
from qdrant_client import QdrantClient, models

COLLECTION = os.getenv("QDRANT_COLLECTION", "shengyue_chunks")
QDRANT_URL = os.getenv("QDRANT_URL", "http://qdrant:6333")
MODEL_NAME = os.getenv("EMBEDDING_MODEL", "BAAI/bge-small-zh-v1.5")

app = FastAPI(title="ShengYue knowledge index", version="1.0.0")


class Chunk(BaseModel):
    id: str = Field(min_length=1, max_length=300)
    heading_path: list[str] = Field(default_factory=list, max_length=16)
    text: str = Field(min_length=1, max_length=8_000)


class UpsertRequest(BaseModel):
    tenant_id: str = Field(min_length=1, max_length=300)
    owner_user_id: str = Field(min_length=1, max_length=300)
    document_id: str = Field(min_length=1, max_length=100)
    document_title: str = Field(min_length=1, max_length=300)
    chunks: list[Chunk] = Field(min_length=1, max_length=500)


class SearchRequest(BaseModel):
    tenant_id: str = Field(min_length=1, max_length=300)
    owner_user_id: str = Field(min_length=1, max_length=300)
    query: str = Field(min_length=1, max_length=2_000)
    limit: int = Field(default=10, ge=1, le=50)


@lru_cache(maxsize=1)
def embedder() -> TextEmbedding:
    return TextEmbedding(model_name=MODEL_NAME)


@lru_cache(maxsize=1)
def qdrant() -> QdrantClient:
    return QdrantClient(url=QDRANT_URL, timeout=20)


def vectorize(values: list[str]) -> list[list[float]]:
    return [vector.tolist() for vector in embedder().embed(values)]


def ensure_collection(vector_size: int) -> None:
    client = qdrant()
    if not client.collection_exists(COLLECTION):
        client.create_collection(
            collection_name=COLLECTION,
            vectors_config=models.VectorParams(size=vector_size, distance=models.Distance.COSINE),
        )
        client.create_payload_index(COLLECTION, "tenant_id", models.PayloadSchemaType.KEYWORD)
        client.create_payload_index(COLLECTION, "owner_user_id", models.PayloadSchemaType.KEYWORD)
        client.create_payload_index(COLLECTION, "document_id", models.PayloadSchemaType.KEYWORD)


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/v1/chunks")
def upsert_chunks(payload: UpsertRequest) -> dict[str, int]:
    vectors = vectorize([chunk.text for chunk in payload.chunks])
    if not vectors:
        raise HTTPException(status_code=422, detail="没有可索引的文本块")
    ensure_collection(len(vectors[0]))
    client = qdrant()
    client.delete(
        collection_name=COLLECTION,
        points_selector=models.FilterSelector(filter=models.Filter(must=[
            models.FieldCondition(key="tenant_id", match=models.MatchValue(value=payload.tenant_id)),
            models.FieldCondition(key="owner_user_id", match=models.MatchValue(value=payload.owner_user_id)),
            models.FieldCondition(key="document_id", match=models.MatchValue(value=payload.document_id)),
        ])),
        wait=True,
    )
    points = [
        models.PointStruct(
            id=str(uuid.uuid5(uuid.NAMESPACE_URL, chunk.id)),
            vector=vector,
            payload={
                "tenant_id": payload.tenant_id,
                "owner_user_id": payload.owner_user_id,
                "document_id": payload.document_id,
                "document_title": payload.document_title,
                "chunk_id": chunk.id,
                "heading_path": chunk.heading_path,
                "text": chunk.text,
            },
        )
        for chunk, vector in zip(payload.chunks, vectors, strict=True)
    ]
    client.upsert(collection_name=COLLECTION, points=points, wait=True)
    return {"indexed": len(points)}


@app.post("/v1/search")
def search(payload: SearchRequest) -> dict[str, list[dict[str, Any]]]:
    query_vector = vectorize([payload.query])[0]
    client = qdrant()
    if not client.collection_exists(COLLECTION):
        return {"items": []}
    results = client.search(
        collection_name=COLLECTION,
        query_vector=query_vector,
        query_filter=models.Filter(must=[
            models.FieldCondition(key="tenant_id", match=models.MatchValue(value=payload.tenant_id)),
            models.FieldCondition(key="owner_user_id", match=models.MatchValue(value=payload.owner_user_id)),
        ]),
        limit=payload.limit,
        with_payload=True,
    )
    return {"items": [
        {
            "document_id": result.payload["document_id"],
            "document_title": result.payload["document_title"],
            "chunk_id": result.payload["chunk_id"],
            "score": result.score,
            "text": result.payload["text"],
            "heading_path": result.payload.get("heading_path", []),
        }
        for result in results
    ]}
