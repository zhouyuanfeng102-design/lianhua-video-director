import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Electron loads dist/index.html through file://. Relative asset URLs are
  // required; the default `/assets/...` paths resolve to the drive root and
  // leave the packaged window black.
  base: './',
  plugins: [react()],
  // Limit dependency discovery to the renderer entry. Otherwise Vite crawls
  // generated Electron LICENSES.chromium.html files under the project root.
  optimizeDeps: {
    entries: ['index.html']
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    watch: {
      ignored: [
        '**/.qa-*/**',
        '**/.edge-qa-profile*/**',
        '**/.chrome-visual-test*/**',
        '**/.runtime-temp*/**',
        '**/.pack-temp*/**',
        '**/.delivery-source-*/**',
        '**/.temp/**',
        '**/release/**',
        '**/output/**',
        '**/交付/**',
        '**/build/media-tools/**',
      ]
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          const normalized = id.replace(/\\/gu, '/');
          if (normalized.includes('/node_modules/lucide-react/')) return 'icons';
          if (
            normalized.includes('/node_modules/react')
            || normalized.includes('/node_modules/scheduler/')
          ) return 'react-vendor';
          if (normalized.includes('/node_modules/')) return 'vendor';
          if (normalized.endsWith('/src/updateLog.ts')) return 'update-log';
          // Several eager rule catalogs read these constants at module scope.
          // Keep them in a dependency-free chunk: the domain fallback imports
          // those catalogs and would create a startup TDZ through their rules.
          if (normalized.endsWith('/src/storyCausalityRules.ts')) return 'story-causality';
          // Dossier editing is independent of the large shared project domain.
          if (['characterDossierApplication.ts', 'components/CharacterDossierApplyDialog.tsx', 'components/CharacterDossierApplyDialog.css']
            .some((file) => normalized.endsWith(`/src/${file}`))) return 'character-dossier';
          // Visual selection only depends on the shared LLM transport and pure
          // retry contracts; keep its bounded request loop with that transport.
          if (normalized.endsWith('/src/services/llm.ts') || normalized.endsWith('/src/videoFrameSelection.ts')
            || normalized.endsWith('/src/services/semanticSequencePlanner.ts')) return 'llm-service';
          // These protocol/naming/planning contracts have no renderer or
          // domain runtime dependencies. Keep this leaf layer together so
          // App, storage, the LLM bridge and H3 delivery can share it without
          // growing domain or creating an initialization cycle. This is an
          // eager bundle boundary, not a new lazy-loading execution path.
          if ([
            'h3PromptProtocol.ts',
            'characterDossierPolicy.ts',
            'projectBackground.ts',
            'h3IdentityBindings.ts',
            'h3StagingMetadata.ts',
            'h3DeliverySchema.ts',
            'h3DeliveryRepair.ts',
            'storyboardDelivery.ts',
            'h3OutputRecovery.ts',
            'videoH3ReferenceBinding.ts',
            'rhtvBridge.ts',
            'videoPrivateScope.ts',
            'videoReferenceUsage.ts',
            'videoReferenceSlots.ts',
            'videoTailFrameRetry.ts',
            'videoOutputParameters.ts',
            'imageApiSelection.ts',
            'characterVocabulary.ts',
            'characterVariants.ts',
            // H3 rule catalogs read its rule at module scope; it must stay in
            // this pure contract layer rather than create a domain back edge.
            'characterParticipation.ts',
            'imagePromptIdentityContext.ts',
            'imageLocationScope.ts',
            'sequencePromptHandoffStamp.ts',
            'videoActingCameraRules.ts',
            'spatialContinuityRules.ts',
            'videoCreativeDirection.ts',
            'errorDiagnostics.ts',
            'videoTaskErrorDiagnostics.ts',
            'sequenceDurationContract.ts',
            'semanticSequencePlan.ts',
            'storyPacingEstimate.ts',
            'sourceContentHash.ts',
            'officialH3SourceIdentity.ts',
            'officialH3Context.ts',
            'storyboardImageH3Source.ts',
            'storyboardImagePlan.ts',
            'storyboardImagePlanJson.ts',
            'storyboardImageNames.ts',
            'storyOptimizationDialogue.ts',
            'storyPreparationReview.ts',
            'videoWorkbench.ts',
            'storyboardVersions.ts',
            'audioPromptPolicy.ts',
          ].some((file) => normalized.endsWith(`/src/${file}`))) return 'generation-contracts';
          // Comfy video graph/protocol helpers have no runtime imports. Keep
          // this leaf separate from domain as node-mapping support grows.
          if (normalized.endsWith('/src/comfyuiVideo.ts')) return 'comfy-video';
          // Keep cloud node catalogs and mapping helpers with their protocol;
          // settings growth must not inflate the shared domain bundle.
          if ([
            'runningHubVideo.ts', 'runningHubVideoNodes.ts', 'runningHubVideoFieldChoices.ts', 'runningHubVideoOutput.ts',
            'videoGenerationSource.ts', 'videoGenerationApi.ts', 'videoTasks.ts',
          ].some((file) => normalized.endsWith(`/src/${file}`))) return 'cloud-video';
          // Workflow management is a settings-only surface. Keep the editor
          // and its library helpers out of the shared project/domain chunk.
          if ([
            'components/VideoGenerationSettings.tsx',
            'components/VideoWorkflowManager.tsx',
            'components/RunningHubVideoSettings.tsx',
            'components/RunningHubWorkflowManager.tsx',
            'components/RhTvBridgeSettings.tsx',
            'runningHubImageSlots.ts',
            'videoWorkflowLibrary.ts',
          ].some((file) => normalized.endsWith(`/src/${file}`))) return 'video-workflow-settings';
          if (['videoRuntimeStore.ts', 'comfyPolling.ts', 'videoBatchSelection.ts'].some((file) => normalized.endsWith(`/src/${file}`))) return 'video-runtime';
          if (['stateSerialization.ts', 'stateSerializationClient.ts', 'imageBatch.ts', 'imageTaskQueue.ts', 'sidebarFit.ts', 'imageOutputSize.ts', 'storyboardImageOutputSize.ts'].some((file) => normalized.endsWith(`/src/${file}`))) return 'state-and-queue';
          // Pixel controls and reference-name presentation depend only on React and the pure size contracts;
          // keep their UI out of the shared project/domain byte budget.
          if (['components/ImageOutputSizeControls.tsx', 'components/StoryboardImageOutputSizeControls.tsx', 'components/ReferenceImageName.tsx'].some((file) => normalized.endsWith(`/src/${file}`))) return 'image-output-controls';
          // Video output controls are a leaf view over generation contracts.
          // Keep MP choices and labels out of domain without changing loading
          // behavior or introducing a dependency on the video director.
          if (['components/VideoOutputParameters.tsx', 'videoOutputParameters.css'].some((file) => normalized.endsWith(`/src/${file}`))) return 'video-output-controls';
          // Direct storyboard image-to-image is entered only by App. Keep its
          // view and orchestration together; shared domain modules do not import
          // this layer, so the eager boundary adds no initialization cycle or
          // new asynchronous loading path.
          if ([
            'storyboardImageToImage.ts',
            'storyboardImageToImageGeneration.ts',
            'components/StoryboardImageToImagePanel.tsx',
            'storyboardImageToImage.css',
          ].some((file) => normalized.endsWith(`/src/${file}`))) return 'image-to-image';
          if (normalized.endsWith('/src/components/VideoWorkbenchView.tsx') || normalized.endsWith('/src/useVideoWorkbenchController.ts')) return 'video-workbench';
          // Image variant/entity helpers and safe result retry snapshots depend
          // only on pure helpers and generation contracts, never storage or
          // renderer state. Keep their shared eager layer together so storage's
          // snapshot normalization does not grow domain or introduce a back edge.
          if (
            normalized.endsWith('/src/imageGeneration.ts')
            || normalized.endsWith('/src/imageAssetRegenerationSnapshot.ts')
            || normalized.endsWith('/src/characterMorphology.ts')
          ) return 'image-generation';
          // Shared catalogs and pure text/workflow helpers do not depend on renderer
          // state. Split this leaf layer without creating a domain cycle.
          if ([
            'comfyui.ts', 'continuity.ts', 'directorStyles.ts', 'generatedImageData.ts', 'imageDimensions.ts', 'imageReferenceData.ts', 'imagePromptRules.ts',
            // The rule catalog eagerly reads these family definitions; keep
            // them together instead of falling back to the domain cycle.
            'imagePromptModelFamilies.ts',
            'modelProfiles.ts', 'novelai.ts', 'nsfwPrivateAssets.ts', 'nsfwPromptRules.ts', 'promptConstraints.ts',
            'semanticEvents.ts', 'sourceIntegrity.ts', 'masterTimeline.ts', 'storyboardSubject.ts', 'storyPacing.ts', 'promptDialogueLanguage.ts', 'promptTranslation.ts',
            'userFacingError.ts', 'videoConversionRules.ts', 'visualStyles.ts',
          ].some((file) => normalized.endsWith(`/src/${file}`))) return 'prompt-foundation';
          if (
            normalized.endsWith('/src/sequenceReferencePrompt.ts')
            || normalized.endsWith('/src/characterDossierPromptRefresh.ts')
            || normalized.endsWith('/src/sequencePromptHandoff.ts')
            || normalized.endsWith('/src/h3EnglishTranslation.ts')
            || normalized.endsWith('/src/h3StagingDelivery.ts')
            || normalized.endsWith('/src/h3IdentityRepair.ts')
            || normalized.endsWith('/src/h3IdentityRepairCommit.ts')
            || normalized.endsWith('/src/singleSegmentPrompt.ts')
          ) return 'h3-delivery';
          // This tiny navigation resolver is imported directly by App and only
          // uses type-only contracts. Keep it out of the generic domain chunk
          // so the eager renderer bundle remains below the byte budget.
          if (normalized.endsWith('/src/videoPromptNavigation.ts')) return 'video-navigation';
          // The H3 prompt display is a self-contained React view with no
          // domain/runtime imports. Keep its parser and renderer in a leaf
          // chunk so App's domain bundle stays below the delivery budget.
          if (normalized.endsWith('/src/components/H3PromptDisplay.tsx')) return 'h3-prompt-display';
          // Keep the video director's renderer and orchestration layer together.
          // These modules are only entered by App and depend on the shared domain
          // layer, so this boundary reduces the generic domain chunk without
          // introducing a domain <-> video chunk cycle.
          if ([
            'components/VideoDirectorView.tsx',
            'components/VideoGenerationSettings.tsx',
            'useVideoGenerationController.ts',
            'videoGeneration.ts',
            'videoTailCharacters.ts',
            'videoQueuePresentation.ts',
            'videoBatchDeletion.ts',
          ].some((file) => normalized.endsWith(`/src/${file}`))) return 'video-director';
          if (
            normalized.includes('/src/')
            && !normalized.endsWith('/src/App.tsx')
            && !normalized.endsWith('/src/main.tsx')
          ) return 'domain';
          return undefined;
        }
      }
    }
  }
});
