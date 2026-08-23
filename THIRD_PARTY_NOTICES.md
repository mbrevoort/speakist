# Third-party notices

Speakist's local transcription option uses these separately licensed projects
and model artifacts:

- [FluidAudio](https://github.com/FluidInference/FluidAudio), pinned from
  version 0.15.5, is licensed under Apache License 2.0.
- [FluidInference Parakeet TDT 0.6B v2 Core ML](https://huggingface.co/FluidInference/parakeet-tdt-0.6b-v2-coreml)
  is downloaded on first use rather than bundled with Speakist. Its model card
  contains the current license, source-model attribution, and use conditions.
- [MLX Swift LM](https://github.com/ml-explore/mlx-swift-lm), pinned to
  version 3.31.3, and its MLX Swift dependencies are licensed under MIT.
- [Qwen2.5 0.5B Instruct 4-bit for MLX](https://huggingface.co/mlx-community/Qwen2.5-0.5B-Instruct-4bit)
  is downloaded when local AI cleanup is selected. Speakist pins
  commit `a5339a4131f135d0fdc6a5c8b5bbed2753bbe0f3`; the model is licensed under
  Apache License 2.0.

The dependency versions used by a build are resolved by Swift Package Manager
from `project.yml`. Model files are cached outside the app bundle by their
respective runtimes.
