// Ugh 
// https://github.com/3F/DllExport/issues/24
// https://github.com/dotnet/runtime/issues/93936
// Thanks https://github.com/VainoKarppi/ArmaExtension/commit/7e061d2d033e8b9af09eae20747ef176fbb470e1
#include <stdint.h>
enum DllExtensionFeatureFlags
{
	RVFeature_ContextArgumentsVoidPtr = 1 << 0,
	RVFeature_ContextStackTrace = 1 << 1,
	RVFeature_ContextNoDefaultCall = 1 << 2,
	RVFeature_ArgumentNoEscapeString = 1 << 3,
};

__declspec(dllexport) uint64_t RVExtensionFeatureFlags = RVFeature_ArgumentNoEscapeString;