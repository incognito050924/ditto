/**
 * @id ditto/nmany
 * @kind table
 */
import java
from Method m, string name, int callers
where m.fromSource()
  and m.getDeclaringType().getPackage().getName().matches("kr.co.ecoletree%")
  and name = m.getName()
  and count(Method o | o.fromSource() and o.getName() = name) = 1
  and callers = count(MethodCall mc | mc.getMethod() = m and mc.getCaller().fromSource())
  and callers >= 2 and callers <= 8
select name, callers order by callers desc
