architecture=
if architecture="$(uname -m 2>/dev/null)" && [ "$architecture" = x86_64 ]; then
  nested_kvm_module=
  if grep -qw vmx /proc/cpuinfo; then
    nested_kvm_module=kvm_intel
  elif grep -qw svm /proc/cpuinfo; then
    nested_kvm_module=kvm_amd
  fi

  if [ -n "$nested_kvm_module" ]; then
    nested_kvm_modules_ready=true
    for module in irqbypass kvm "$nested_kvm_module"; do
      compressed_module=
      if compressed_module="$(modinfo -n "$module" 2>/dev/null)"; then
        case "$compressed_module" in
          *.gz)
            uncompressed_module="${compressed_module%.gz}"
            if gzip -dc "$compressed_module" > "$uncompressed_module.tmp" &&
              mv "$uncompressed_module.tmp" "$uncompressed_module" &&
              rm "$compressed_module"; then
              :
            else
              rm -f "$uncompressed_module.tmp" || :
              echo "openorb: could not prepare compressed KVM module $module" >&2
              nested_kvm_modules_ready=false
            fi
            ;;
        esac
      else
        echo "openorb: could not locate KVM module $module" >&2
        nested_kvm_modules_ready=false
      fi
    done
    if [ "$nested_kvm_modules_ready" = true ]; then
      if depmod -a; then
        if ! modprobe "$nested_kvm_module"; then
          echo "openorb: could not load KVM module $nested_kvm_module" >&2
        fi
      else
        echo "openorb: could not refresh module dependencies" >&2
      fi
    fi
  fi
fi

:
