# Third party notices

Sentence Transformers all-MiniLM-L6-v2 maps text to 384-dimensional embeddings. Its model card identifies Apache 2.0 licensing, English-language use and token truncation limits: https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2 . We use it for local retrieval, not as a generative model. Short character-bounded chunks reduce truncation but do not guarantee every token survives.

FastEmbed provides ONNX-based inference; see https://qdrant.github.io/fastembed/ and upstream licenses. Runtime dependencies retain their respective licenses. The application does not redistribute model weights in Git. Downloaded model files and license metadata remain in the local cache.

The merchant policies and questions are original fictional evaluation fixtures. They are not statements of law, external merchant policies, real customer records or legal/financial advice.
